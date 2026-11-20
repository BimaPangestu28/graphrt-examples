/**
 * Errors raised by the stream transport. Each says how far the request got,
 * which is what decides whether it is safe to retry automatically.
 */

/** serve answered with a non-2xx status before streaming (nothing ran). */
export class HttpStatusError extends Error {
  readonly status: number;
  /** Raw `Retry-After` header, if any. */
  readonly retryAfterHeader: string | null;

  constructor(status: number, message: string, retryAfterHeader: string | null) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
    this.retryAfterHeader = retryAfterHeader;
  }
}

/** The connection failed before any response headers arrived. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * The stream broke (error, idle timeout or early close) after serve accepted the
 * run. The run may have done work, so this is never retried automatically.
 */
export class StreamDroppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamDroppedError';
  }
}

/** The caller cancelled the request (e.g. the screen was left). */
export class RequestCancelledError extends Error {
  constructor() {
    super('Request cancelled.');
    this.name = 'RequestCancelledError';
  }
}
