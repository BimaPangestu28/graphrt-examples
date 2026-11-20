import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpStatusError, NetworkError, StreamDroppedError } from '../src/net/errors.ts';
import {
  DEFAULT_RETRY_POLICY,
  computeBackoffDelay,
  decideRetry,
  parseRetryAfter,
  type RetryState,
} from '../src/net/retryPolicy.ts';

const FRESH: RetryState = { retriesUsed: 0, tokenRefreshed: false };
const noJitter = (): number => 0;
const httpError = (status: number, retryAfter: string | null = null) => new HttpStatusError(status, 'x', retryAfter);

describe('decideRetry', () => {
  it('refreshes the token once on 401, then gives up', () => {
    assert.deepEqual(decideRetry(httpError(401), FRESH), { action: 'refresh_token' });
    assert.deepEqual(decideRetry(httpError(401), { retriesUsed: 0, tokenRefreshed: true }), { action: 'give_up' });
  });

  it('refreshes on 401 even when the backoff retries are used up', () => {
    assert.deepEqual(decideRetry(httpError(401), { retriesUsed: 3, tokenRefreshed: false }), {
      action: 'refresh_token',
    });
  });

  it('waits Retry-After seconds on a rate-limit 429', () => {
    assert.deepEqual(decideRetry(httpError(429, '2'), FRESH, DEFAULT_RETRY_POLICY, noJitter), {
      action: 'wait',
      delayMs: 2000,
      reason: 'rate_limited',
    });
  });

  it('gives up when Retry-After is longer than the policy allows', () => {
    assert.deepEqual(decideRetry(httpError(429, '120'), FRESH), { action: 'give_up' });
  });

  it('backs off on 429 without Retry-After, 502/503/504 and network errors', () => {
    for (const error of [httpError(429), httpError(502), httpError(503), httpError(504), new NetworkError('down')]) {
      assert.deepEqual(decideRetry(error, { retriesUsed: 1, tokenRefreshed: false }, DEFAULT_RETRY_POLICY, noJitter), {
        action: 'wait',
        delayMs: 500,
        reason: 'transient',
      });
    }
  });

  it('stops after maxRetries', () => {
    assert.deepEqual(decideRetry(httpError(503), { retriesUsed: 3, tokenRefreshed: false }), { action: 'give_up' });
  });

  it('never retries client errors, server bugs or dropped streams', () => {
    for (const error of [
      httpError(400),
      httpError(413),
      httpError(415),
      httpError(500),
      new StreamDroppedError('x'),
      new Error('?'),
    ]) {
      assert.deepEqual(decideRetry(error, FRESH), { action: 'give_up' }, String(error));
    }
  });
});

describe('computeBackoffDelay', () => {
  it('doubles per retry with equal jitter and respects the cap', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 500, maxDelayMs: 4000 };
    assert.deepEqual(
      [0, 1, 2, 3, 4, 10].map((retryIndex) => computeBackoffDelay(retryIndex, policy, () => 0)),
      [250, 500, 1000, 2000, 2000, 2000],
    );
    assert.equal(
      computeBackoffDelay(2, policy, () => 0.999999),
      2000,
    );
    assert.equal(
      computeBackoffDelay(10, policy, () => 0.999999),
      4000,
    );
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-20T10:00:00Z');

  it('reads delay-seconds', () => {
    assert.equal(parseRetryAfter('3', now), 3000);
    assert.equal(parseRetryAfter(' 0 ', now), 0);
  });

  it('reads an HTTP-date relative to now, never negative', () => {
    assert.equal(parseRetryAfter('Fri, 20 Nov 2026 10:00:05 GMT', now), 5000);
    assert.equal(parseRetryAfter('Fri, 20 Nov 2026 09:00:00 GMT', now), 0);
  });

  it('returns undefined for missing or garbage values', () => {
    assert.equal(parseRetryAfter(null, now), undefined);
    assert.equal(parseRetryAfter('', now), undefined);
    assert.equal(parseRetryAfter('soon', now), undefined);
    assert.equal(parseRetryAfter('-1', now), undefined);
  });
});
