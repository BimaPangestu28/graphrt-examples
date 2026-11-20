/**
 * Pure retry decisions for one chat request to `graphrt serve`.
 *
 * Rules (from the serve contract):
 * - 401: the access token is missing, invalid or expired → refresh the Supabase
 *   session and retry once. A second 401 gives up (the user must sign in again).
 * - 429 with Retry-After: per-user rate limit → wait that long (capped), retry.
 * - 429 without Retry-After, 502/503/504, or a network error before any
 *   response: transient → exponential backoff with jitter.
 * - 400 / 413 / other statuses: the request itself is wrong → give up.
 * - A stream that drops after serve accepted the run → give up here; the UI
 *   keeps the partial text and offers a manual retry (the run may have done work).
 */
import { HttpStatusError, NetworkError } from './errors.ts';

export interface RetryPolicy {
  /** Automatic retries after the first attempt (refresh retry not counted). */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Longest Retry-After we are willing to wait in the background. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  maxRetryAfterMs: 30000,
};

export type RetryDecision =
  | { action: 'refresh_token' }
  | { action: 'wait'; delayMs: number; reason: 'rate_limited' | 'transient' }
  | { action: 'give_up' };

export interface RetryState {
  /** Retries already used (0 on the first failure). */
  retriesUsed: number;
  /** Whether the token was already refreshed for this request. */
  tokenRefreshed: boolean;
}

const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/**
 * Decide what to do after a failed attempt.
 *
 * @param error - What the attempt threw (unknown)
 * @param state - Retries used so far (RetryState)
 * @param policy - Limits (RetryPolicy)
 * @param random - Source of jitter in [0, 1), injectable for tests (() => number)
 * @param nowMs - Current time for HTTP-date Retry-After values (number)
 * @returns The next step (RetryDecision)
 */
export function decideRetry(
  error: unknown,
  state: RetryState,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
  nowMs: number = Date.now(),
): RetryDecision {
  if (error instanceof HttpStatusError && error.status === 401) {
    return state.tokenRefreshed ? { action: 'give_up' } : { action: 'refresh_token' };
  }
  if (state.retriesUsed >= policy.maxRetries) {
    return { action: 'give_up' };
  }
  if (error instanceof HttpStatusError && TRANSIENT_STATUSES.has(error.status)) {
    const retryAfterMs = error.status === 429 ? parseRetryAfter(error.retryAfterHeader, nowMs) : undefined;
    if (retryAfterMs !== undefined) {
      return retryAfterMs > policy.maxRetryAfterMs
        ? { action: 'give_up' }
        : { action: 'wait', delayMs: retryAfterMs, reason: 'rate_limited' };
    }
    return { action: 'wait', delayMs: computeBackoffDelay(state.retriesUsed, policy, random), reason: 'transient' };
  }
  if (error instanceof NetworkError) {
    return { action: 'wait', delayMs: computeBackoffDelay(state.retriesUsed, policy, random), reason: 'transient' };
  }
  return { action: 'give_up' };
}

/**
 * Exponential backoff with "equal jitter": half fixed, half random, so retries
 * from many phones do not line up.
 *
 * @param retryIndex - 0 for the first retry (number)
 * @param policy - Base and cap (RetryPolicy)
 * @param random - Jitter source in [0, 1) (() => number)
 * @returns Delay in milliseconds (number)
 *
 * @example
 * computeBackoffDelay(2, DEFAULT_RETRY_POLICY, () => 0); // 1000 (half of 2000)
 */
export function computeBackoffDelay(retryIndex: number, policy: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** retryIndex);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * Parse a `Retry-After` header: delay-seconds or an HTTP-date.
 *
 * @param headerValue - The raw header (string | null)
 * @param nowMs - Current time in ms, for HTTP-dates (number)
 * @returns Delay in ms, or undefined when absent or unparseable (number | undefined)
 */
export function parseRetryAfter(headerValue: string | null, nowMs: number): number | undefined {
  const trimmed = headerValue?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  // An HTTP-date always names the weekday/month; this rejects "-1" and the like.
  const dateMs = /[a-z]/i.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - nowMs);
}
