/**
 * POST a request and read the `text/event-stream` answer incrementally.
 *
 * React Native's `fetch` has no streaming body, so this uses XMLHttpRequest and
 * reads the growing `responseText` on each progress event (what SSE libraries for
 * React Native do too). Works the same on iOS, Android and web, without a
 * native module.
 */
import { SseParser, type SseEvent } from '../sse/sseParser.ts';
import { HttpStatusError, NetworkError, RequestCancelledError, StreamDroppedError } from './errors.ts';

export interface EventStreamRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Called per SSE event; return 'stop' to close the stream early (e.g. after a terminal event). */
  onEvent: (event: SseEvent) => 'stop' | void;
  signal?: AbortSignal;
  /** Fail when nothing (not even a keep-alive) arrives for this long. */
  idleTimeoutMs: number;
}

/**
 * Opens a stream; resolves when it closes (cleanly or by 'stop').
 * Rejects with HttpStatusError, NetworkError, StreamDroppedError or RequestCancelledError.
 */
export type OpenEventStream = (request: EventStreamRequest) => Promise<void>;

export const openXhrEventStream: OpenEventStream = (request) =>
  new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const parser = new SseParser();
    let readIndex = 0;
    let settled = false;
    let headersReceived = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (finish: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(idleTimer);
      request.signal?.removeEventListener('abort', handleAbort);
      finish();
    };
    const lostConnection = (message: string): Error =>
      headersReceived ? new StreamDroppedError(message) : new NetworkError(message);
    const restartIdleTimer = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        settle(() => reject(lostConnection(`No data from the server for ${request.idleTimeoutMs / 1000} s.`)));
        xhr.abort();
      }, request.idleTimeoutMs);
    };
    const isStreaming = (): boolean => xhr.status >= 200 && xhr.status < 300;
    const drainNewText = (): void => {
      if (settled || !isStreaming()) {
        return;
      }
      const newText = xhr.responseText.slice(readIndex);
      readIndex = xhr.responseText.length;
      for (const event of parser.push(newText)) {
        if (request.onEvent(event) === 'stop') {
          settle(resolve);
          xhr.abort();
          return;
        }
      }
    };
    function handleAbort(): void {
      settle(() => reject(new RequestCancelledError()));
      xhr.abort();
    }

    xhr.onreadystatechange = () => {
      if (xhr.readyState >= XMLHttpRequest.HEADERS_RECEIVED && xhr.status !== 0) {
        headersReceived = true;
      }
    };
    xhr.onprogress = () => {
      restartIdleTimer();
      drainNewText();
    };
    xhr.onload = () => {
      if (!isStreaming()) {
        settle(() => reject(toHttpStatusError(xhr)));
        return;
      }
      drainNewText();
      parser.end();
      settle(resolve);
    };
    xhr.onerror = () => settle(() => reject(lostConnection('The connection to the server was lost.')));

    if (request.signal?.aborted) {
      settle(() => reject(new RequestCancelledError()));
      return;
    }
    request.signal?.addEventListener('abort', handleAbort);
    xhr.open('POST', request.url);
    for (const [headerName, headerValue] of Object.entries(request.headers)) {
      xhr.setRequestHeader(headerName, headerValue);
    }
    restartIdleTimer();
    xhr.send(request.body);
  });

function toHttpStatusError(xhr: XMLHttpRequest): HttpStatusError {
  let message = `The server answered HTTP ${xhr.status}.`;
  try {
    const parsed: unknown = JSON.parse(xhr.responseText);
    const serverMessage = (parsed as { error?: unknown } | null)?.error;
    if (typeof serverMessage === 'string' && serverMessage) {
      message = serverMessage;
    }
  } catch {
    // Not JSON (e.g. a proxy page): keep the generic message.
  }
  return new HttpStatusError(xhr.status, message, xhr.getResponseHeader('Retry-After'));
}
