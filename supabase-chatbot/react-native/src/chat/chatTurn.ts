/**
 * Runs one chat turn against `graphrt serve`: sends the request with the user's
 * Supabase access token, streams the answer and applies the retry rules.
 *
 * - 401 → refresh the Supabase session, retry once.
 * - 429 / 5xx / network error before the stream starts → wait and retry
 *   (Retry-After or backoff), see retryPolicy.ts.
 * - The stream drops after it started → `dropped` with the partial text; the UI
 *   offers a retry instead of re-running silently.
 *
 * All I/O is injected (ChatTurnDependencies), so this is tested with fakes.
 */
import { HttpStatusError, NetworkError, RequestCancelledError, StreamDroppedError } from '../net/errors.ts';
import type { OpenEventStream } from '../net/eventStream.ts';
import { DEFAULT_RETRY_POLICY, decideRetry, type RetryPolicy, type RetryState } from '../net/retryPolicy.ts';
import type { SseEvent } from '../sse/sseParser.ts';
import { TERMINAL_KINDS, interpretServeEvent, type ServeStreamEvent } from '../sse/serveEvents.ts';

export interface ChatTurnDependencies {
  openEventStream: OpenEventStream;
  /** The current Supabase access token; throws when signed out. */
  getAccessToken: () => Promise<string>;
  /** Refresh the Supabase session and return the new access token. */
  refreshAccessToken: () => Promise<string>;
  /** Wait; rejects with RequestCancelledError when the signal aborts. */
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface ChatTurnRequest {
  /** {SERVE_URL}/v1/workflows/{workflow}/runs */
  runUrl: string;
  /** JSON body from buildRunBody. */
  body: string;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
}

export interface ChatTurnCallbacks {
  /** The whole answer so far (not just the delta). */
  onText: (answerSoFar: string) => void;
  /** Names of tools currently running; empty when none. */
  onToolActivity: (runningToolNames: string[]) => void;
  onRetryScheduled?: (retry: { delayMs: number; reason: 'rate_limited' | 'transient' }) => void;
}

export type ChatTurnOutcome =
  | { status: 'succeeded'; text: string }
  | { status: 'dropped'; text: string; message: string }
  | { status: 'failed'; text: string; message: string; canRetry: boolean; signInRequired: boolean }
  | { status: 'cancelled'; text: string };

const DEFAULT_IDLE_TIMEOUT_MS = 60000;

/**
 * Send one message and stream the answer.
 *
 * @param request - URL, body and cancellation (ChatTurnRequest)
 * @param dependencies - Transport, token access and timers (ChatTurnDependencies)
 * @param callbacks - Progress for the UI (ChatTurnCallbacks)
 * @param policy - Retry limits (RetryPolicy)
 * @returns How the turn ended; never throws (Promise<ChatTurnOutcome>)
 */
export async function runChatTurn(
  request: ChatTurnRequest,
  dependencies: ChatTurnDependencies,
  callbacks: ChatTurnCallbacks,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<ChatTurnOutcome> {
  const retryState: RetryState = { retriesUsed: 0, tokenRefreshed: false };
  let accessToken: string;
  try {
    accessToken = await dependencies.getAccessToken();
  } catch {
    return signInRequiredOutcome('');
  }
  for (;;) {
    const attempt = new StreamAttempt(callbacks);
    try {
      await dependencies.openEventStream({
        url: request.runUrl,
        headers: buildRunHeaders(accessToken),
        body: request.body,
        onEvent: (event) => attempt.handleEvent(event),
        signal: request.signal,
        idleTimeoutMs: request.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      });
      return attempt.toOutcome();
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        return { status: 'cancelled', text: attempt.answerText };
      }
      if (error instanceof StreamDroppedError) {
        return { status: 'dropped', text: attempt.answerText, message: error.message };
      }
      const decision = decideRetry(error, retryState, policy, dependencies.random);
      if (decision.action === 'give_up') {
        return describeRequestFailure(error, retryState);
      }
      if (decision.action === 'refresh_token') {
        retryState.tokenRefreshed = true;
        try {
          accessToken = await dependencies.refreshAccessToken();
        } catch {
          return signInRequiredOutcome('');
        }
        continue;
      }
      callbacks.onRetryScheduled?.({ delayMs: decision.delayMs, reason: decision.reason });
      try {
        await dependencies.sleep(decision.delayMs, request.signal);
      } catch {
        return { status: 'cancelled', text: '' };
      }
      retryState.retriesUsed += 1;
    }
  }
}

/** serve takes the user token in X-User-Authorization; never send Authorization. */
export function buildRunHeaders(accessToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'X-User-Authorization': `Bearer ${accessToken}`,
  };
}

/** Accumulates one stream's answer text, tool activity and terminal event. */
class StreamAttempt {
  answerText = '';
  private terminalEvent: ServeStreamEvent | undefined;
  private readonly runningTools = new Map<string, string>();
  private readonly callbacks: ChatTurnCallbacks;

  constructor(callbacks: ChatTurnCallbacks) {
    this.callbacks = callbacks;
  }

  handleEvent(event: SseEvent): 'stop' | void {
    const streamEvent = interpretServeEvent(event);
    switch (streamEvent.kind) {
      case 'text':
        this.answerText += streamEvent.text;
        this.callbacks.onText(this.answerText);
        return undefined;
      case 'tool_started':
        this.runningTools.set(streamEvent.callId, streamEvent.toolName);
        this.callbacks.onToolActivity([...this.runningTools.values()]);
        return undefined;
      case 'tool_finished':
        this.runningTools.delete(streamEvent.callId);
        this.callbacks.onToolActivity([...this.runningTools.values()]);
        return undefined;
      default:
        break;
    }
    if (!TERMINAL_KINDS.has(streamEvent.kind)) {
      return undefined;
    }
    this.terminalEvent = streamEvent;
    if (this.runningTools.size > 0) {
      this.runningTools.clear();
      this.callbacks.onToolActivity([]);
    }
    return 'stop';
  }

  toOutcome(): ChatTurnOutcome {
    const text = this.answerText;
    const terminal = this.terminalEvent;
    switch (terminal?.kind) {
      case 'run_succeeded':
        return { status: 'succeeded', text };
      case 'run_failed':
        return failedOutcome(text, terminal.error, terminal.errorType !== 'invalid_input');
      case 'run_aborted':
        return failedOutcome(text, 'The answer was stopped on the server.', true);
      case 'run_paused':
        return failedOutcome(text, 'This answer needs an approval step the app does not support.', false);
      default:
        return { status: 'dropped', text, message: 'The connection closed before the answer finished.' };
    }
  }
}

function failedOutcome(text: string, message: string, canRetry: boolean): ChatTurnOutcome {
  return { status: 'failed', text, message, canRetry, signInRequired: false };
}

function signInRequiredOutcome(text: string): ChatTurnOutcome {
  return {
    status: 'failed',
    text,
    message: 'Your session has expired. Please sign in again.',
    canRetry: false,
    signInRequired: true,
  };
}

function describeRequestFailure(error: unknown, retryState: RetryState): ChatTurnOutcome {
  if (error instanceof NetworkError) {
    return failedOutcome('', `Can't reach the chat server. ${error.message}`, true);
  }
  if (!(error instanceof HttpStatusError)) {
    return failedOutcome('', error instanceof Error ? error.message : 'Unexpected error.', true);
  }
  switch (error.status) {
    case 401:
      return retryState.tokenRefreshed ? signInRequiredOutcome('') : failedOutcome('', error.message, false);
    case 429:
      return failedOutcome('', 'You are sending messages too fast. Wait a moment and retry.', true);
    case 413:
      return failedOutcome('', 'This conversation is too long to send. Start a new chat.', false);
    default:
      return failedOutcome('', error.message, error.status >= 500);
  }
}
