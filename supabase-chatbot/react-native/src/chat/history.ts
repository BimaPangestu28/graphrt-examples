/**
 * Builds the run request body: the new message, the session id and the last N
 * turns of saved history as `sys.history` (oldest first, without the new
 * message), trimmed so the JSON stays under serve's 64 KiB body limit.
 */

export type ChatRole = 'user' | 'assistant';

export interface HistoryMessage {
  role: ChatRole;
  content: string;
}

/** serve rejects (run_failed `invalid_input`) a longer message. */
export const MAX_MESSAGE_CHARS = 4000;
/** serve answers 413 above 64 KiB; keep a margin for headers-in-body changes. */
export const MAX_BODY_BYTES = 60 * 1024;

/**
 * Check a message before sending it, so the user gets instant feedback.
 *
 * @param message - What the user typed (string)
 * @returns An error message, or undefined when valid (string | undefined)
 */
export function validateMessage(message: string): string | undefined {
  if (message.trim() === '') {
    return 'Type a message first.';
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return `Messages are limited to ${MAX_MESSAGE_CHARS} characters (this one has ${message.length}).`;
  }
  return undefined;
}

/**
 * Keep the last `maxTurns` exchanges (2 messages each) of a conversation.
 *
 * @param messages - Saved messages, oldest first (HistoryMessage[])
 * @param maxTurns - Turns to keep; serve itself uses at most 8 (number)
 * @returns Plain {role, content} pairs, oldest first (HistoryMessage[])
 */
export function selectRecentHistory(messages: readonly HistoryMessage[], maxTurns: number): HistoryMessage[] {
  const keepCount = Math.max(0, Math.floor(maxTurns) * 2);
  return messages.slice(Math.max(0, messages.length - keepCount)).map(({ role, content }) => ({ role, content }));
}

export interface RunBodyInput {
  message: string;
  sessionId?: string;
  history: readonly HistoryMessage[];
  /** The user's local date, YYYY-MM-DD. */
  today: string;
}

/**
 * Serialize the request body, dropping the oldest history messages while it is
 * larger than `maxBytes`.
 *
 * @param input - Message, session, history and date (RunBodyInput)
 * @param maxBytes - Body size limit in UTF-8 bytes (number)
 * @returns The JSON body (string)
 */
export function buildRunBody(input: RunBodyInput, maxBytes: number = MAX_BODY_BYTES): string {
  let history = [...input.history];
  for (;;) {
    const body = JSON.stringify({
      stream: true,
      inputs: input.sessionId ? { message: input.message, session_id: input.sessionId } : { message: input.message },
      sys: { history, today: input.today },
    });
    if (history.length === 0 || utf8ByteLength(body) <= maxBytes) {
      return body;
    }
    history = history.slice(1);
  }
}

/** Local calendar date as YYYY-MM-DD (not UTC, so "today" matches the user). */
export function formatLocalDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** UTF-8 size without TextEncoder, which older JS engines lack. */
export function utf8ByteLength(text: string): number {
  let byteCount = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    byteCount += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
  }
  return byteCount;
}
