import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runChatTurn, type ChatTurnDependencies } from '../src/chat/chatTurn.ts';
import { HttpStatusError, NetworkError, RequestCancelledError, StreamDroppedError } from '../src/net/errors.ts';
import type { EventStreamRequest } from '../src/net/eventStream.ts';
import { DEFAULT_RETRY_POLICY } from '../src/net/retryPolicy.ts';

const RUN_URL = 'https://serve.test/v1/workflows/agent/runs';

type ScriptedAttempt = { events?: Array<[string, unknown]>; error?: Error };

const response = (text: string): [string, unknown] => ['response', { node_id: 'answer', text, is_final: false }];
const succeeded: [string, unknown] = ['run_succeeded', { type: 'run_succeeded' }];

/** A fake transport that plays one scripted attempt per call and records requests. */
function createHarness(attempts: ScriptedAttempt[], options: { refreshFails?: boolean } = {}) {
  const requests: EventStreamRequest[] = [];
  const sleeps: number[] = [];
  let refreshCount = 0;
  const dependencies: ChatTurnDependencies = {
    openEventStream: async (request) => {
      requests.push(request);
      const attempt = attempts.shift();
      assert.ok(attempt, 'unexpected extra attempt');
      for (const [type, payload] of attempt.events ?? []) {
        if (request.onEvent({ type, data: JSON.stringify(payload) }) === 'stop') {
          return;
        }
      }
      if (attempt.error) {
        throw attempt.error;
      }
    },
    getAccessToken: async () => 'token-1',
    refreshAccessToken: async () => {
      refreshCount += 1;
      if (options.refreshFails) {
        throw new Error('refresh token revoked');
      }
      return 'token-2';
    },
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
    },
    random: () => 0,
  };
  const texts: string[] = [];
  const toolActivity: string[][] = [];
  const callbacks = {
    onText: (text: string) => texts.push(text),
    onToolActivity: (names: string[]) => toolActivity.push(names),
  };
  const run = () => runChatTurn({ runUrl: RUN_URL, body: '{"stream":true}' }, dependencies, callbacks);
  return { run, requests, sleeps, texts, toolActivity, refreshCount: () => refreshCount };
}

describe('runChatTurn', () => {
  it('streams the answer token by token with the user token in X-User-Authorization', async () => {
    const harness = createHarness([{ events: [response('Hel'), response('lo'), succeeded] }]);
    const outcome = await harness.run();
    assert.deepEqual(outcome, { status: 'succeeded', text: 'Hello' });
    assert.deepEqual(harness.texts, ['Hel', 'Hello']);
    const headers = harness.requests[0].headers;
    assert.equal(headers['X-User-Authorization'], 'Bearer token-1');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(
      Object.keys(headers).some((name) => name.toLowerCase() === 'authorization'),
      false,
    );
    assert.equal(harness.requests[0].url, RUN_URL);
  });

  it('stops reading at the terminal event', async () => {
    const harness = createHarness([{ events: [response('Hi'), succeeded, response(' ignored')] }]);
    assert.deepEqual(await harness.run(), { status: 'succeeded', text: 'Hi' });
  });

  it('reports running tools and clears them', async () => {
    const harness = createHarness([
      {
        events: [
          ['node_progress', { name: 'tool_call', data: { id: 'a', name: 'supabase/call_function' } }],
          ['node_progress', { name: 'tool_result', data: { id: 'a', name: 'supabase/call_function' } }],
          response('Done'),
          succeeded,
        ],
      },
    ]);
    await harness.run();
    assert.deepEqual(harness.toolActivity, [['supabase/call_function'], []]);
  });

  it('refreshes an expired token and retries once with the new token', async () => {
    const harness = createHarness([
      { error: new HttpStatusError(401, 'token expired', null) },
      { events: [response('Hi'), succeeded] },
    ]);
    assert.deepEqual(await harness.run(), { status: 'succeeded', text: 'Hi' });
    assert.equal(harness.refreshCount(), 1);
    assert.equal(harness.requests[1].headers['X-User-Authorization'], 'Bearer token-2');
    assert.deepEqual(harness.sleeps, []);
  });

  it('asks to sign in again when the refreshed token is refused too', async () => {
    const harness = createHarness([
      { error: new HttpStatusError(401, 'expired', null) },
      { error: new HttpStatusError(401, 'expired', null) },
    ]);
    const outcome = await harness.run();
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.status === 'failed' && outcome.signInRequired, true);
    assert.equal(harness.refreshCount(), 1);
  });

  it('asks to sign in again when the refresh itself fails', async () => {
    const harness = createHarness([{ error: new HttpStatusError(401, 'expired', null) }], { refreshFails: true });
    const outcome = await harness.run();
    assert.equal(outcome.status === 'failed' && outcome.signInRequired, true);
  });

  it('waits Retry-After on a rate limit, then succeeds', async () => {
    const harness = createHarness([
      { error: new HttpStatusError(429, 'rate limit exceeded', '2') },
      { events: [response('Ok'), succeeded] },
    ]);
    assert.deepEqual(await harness.run(), { status: 'succeeded', text: 'Ok' });
    assert.deepEqual(harness.sleeps, [2000]);
  });

  it('backs off exponentially on network errors and gives up after maxRetries', async () => {
    const attempts = Array.from({ length: DEFAULT_RETRY_POLICY.maxRetries + 1 }, () => ({
      error: new NetworkError('offline'),
    }));
    const harness = createHarness(attempts);
    const outcome = await harness.run();
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.status === 'failed' && outcome.canRetry, true);
    assert.deepEqual(harness.sleeps, [250, 500, 1000]);
    assert.equal(harness.requests.length, 4);
  });

  it('keeps the partial text and does not auto-retry when the stream drops', async () => {
    const harness = createHarness([
      { events: [response('Half an ans')], error: new StreamDroppedError('connection lost') },
    ]);
    const outcome = await harness.run();
    assert.deepEqual(outcome, { status: 'dropped', text: 'Half an ans', message: 'connection lost' });
    assert.equal(harness.requests.length, 1);
  });

  it('treats a stream that closes without a terminal event as dropped', async () => {
    const harness = createHarness([{ events: [response('Partial')] }]);
    const outcome = await harness.run();
    assert.equal(outcome.status, 'dropped');
    assert.equal(outcome.text, 'Partial');
  });

  it('does not offer a retry for invalid input, but does for other run failures', async () => {
    const invalid = createHarness([
      { events: [['run_failed', { error: 'invalid_input: message too long', error_type: 'invalid_input' }]] },
    ]);
    const invalidOutcome = await invalid.run();
    assert.equal(invalidOutcome.status === 'failed' && invalidOutcome.canRetry, false);

    const upstream = createHarness([
      { events: [['run_failed', { error: 'provider timeout', error_type: 'timeout' }]] },
    ]);
    const upstreamOutcome = await upstream.run();
    assert.deepEqual(upstreamOutcome, {
      status: 'failed',
      text: '',
      message: 'provider timeout',
      canRetry: true,
      signInRequired: false,
    });
  });

  it('does not retry client errors such as 413', async () => {
    const harness = createHarness([{ error: new HttpStatusError(413, 'payload too large', null) }]);
    const outcome = await harness.run();
    assert.equal(outcome.status === 'failed' && outcome.canRetry, false);
    assert.equal(harness.requests.length, 1);
  });

  it('returns cancelled with the text so far when the user stops', async () => {
    const harness = createHarness([{ events: [response('So far')], error: new RequestCancelledError() }]);
    assert.deepEqual(await harness.run(), { status: 'cancelled', text: 'So far' });
  });
});
