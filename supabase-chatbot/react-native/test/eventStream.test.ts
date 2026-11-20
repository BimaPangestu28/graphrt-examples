import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { HttpStatusError, NetworkError, RequestCancelledError, StreamDroppedError } from '../src/net/errors.ts';
import { openXhrEventStream, type EventStreamRequest } from '../src/net/eventStream.ts';
import type { SseEvent } from '../src/sse/sseParser.ts';

/** A scriptable stand-in for React Native's XMLHttpRequest. */
class FakeXhr {
  static readonly HEADERS_RECEIVED = 2;
  static latest: FakeXhr;
  readyState = 0;
  status = 0;
  responseText = '';
  requestHeaders: Record<string, string> = {};
  sentBody: string | undefined;
  aborted = false;
  responseHeaders: Record<string, string> = {};
  onreadystatechange: (() => void) | null = null;
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeXhr.latest = this;
  }
  open(): void {
    this.readyState = 1;
  }
  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }
  send(body: string): void {
    this.sentBody = body;
  }
  abort(): void {
    this.aborted = true;
  }
  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }
  // Test controls
  receiveHeaders(status: number, headers: Record<string, string> = {}): void {
    this.status = status;
    this.responseHeaders = headers;
    this.readyState = 2;
    this.onreadystatechange?.();
  }
  receiveText(text: string): void {
    this.responseText += text;
    this.readyState = 3;
    this.onprogress?.();
  }
  finish(): void {
    this.readyState = 4;
    this.onload?.();
  }
  fail(): void {
    this.onerror?.();
  }
}

const originalXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;

function openStream(overrides: Partial<EventStreamRequest> = {}) {
  const events: SseEvent[] = [];
  const done = openXhrEventStream({
    url: 'https://serve.test/runs',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    onEvent: (event) => {
      events.push(event);
      return event.type === 'run_succeeded' ? 'stop' : undefined;
    },
    idleTimeoutMs: 1000,
    ...overrides,
  });
  return { done, events, xhr: FakeXhr.latest };
}

describe('openXhrEventStream', () => {
  beforeEach(() => {
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
  });
  afterEach(() => {
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = originalXhr;
  });

  it('sends the headers and body and delivers events as text arrives', async () => {
    const { done, events, xhr } = openStream();
    assert.equal(xhr.requestHeaders['Content-Type'], 'application/json');
    assert.equal(xhr.sentBody, '{}');
    xhr.receiveHeaders(200);
    xhr.receiveText('event: response\ndata: {"text":"Hel');
    assert.equal(events.length, 0);
    xhr.receiveText('lo"}\n\nevent: run_succeeded\ndata: {}\n\n');
    await done;
    assert.deepEqual(
      events.map((event) => event.type),
      ['response', 'run_succeeded'],
    );
    assert.equal(xhr.aborted, true, 'closed after the terminal event');
  });

  it('rejects non-2xx answers with the JSON error and Retry-After', async () => {
    const { done, xhr } = openStream();
    xhr.receiveHeaders(429, { 'retry-after': '7' });
    xhr.responseText = '{"error":"rate limit exceeded for this user; retry later"}';
    xhr.finish();
    await assert.rejects(done, (error: unknown) => {
      assert.ok(error instanceof HttpStatusError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterHeader, '7');
      assert.equal(error.message, 'rate limit exceeded for this user; retry later');
      return true;
    });
  });

  it('keeps a generic message for plain-text error bodies', async () => {
    const { done, xhr } = openStream();
    xhr.receiveHeaders(415);
    xhr.responseText = 'Expected request with `Content-Type: application/json`';
    xhr.finish();
    await assert.rejects(done, (error: unknown) => error instanceof HttpStatusError && error.message.includes('415'));
  });

  it('reports a network error before headers and a dropped stream after', async () => {
    const before = openStream();
    before.xhr.fail();
    await assert.rejects(before.done, NetworkError);

    const after = openStream();
    after.xhr.receiveHeaders(200);
    after.xhr.receiveText('event: response\ndata: {"text":"Hi"}\n\n');
    after.xhr.fail();
    await assert.rejects(after.done, StreamDroppedError);
    assert.equal(after.events.length, 1);
  });

  it('times out when the server goes silent', async () => {
    const { done, xhr } = openStream({ idleTimeoutMs: 20 });
    xhr.receiveHeaders(200);
    xhr.receiveText(': keep-alive\n\n');
    await assert.rejects(done, StreamDroppedError);
    assert.equal(xhr.aborted, true);
  });

  it('rejects with RequestCancelledError when aborted', async () => {
    const controller = new AbortController();
    const { done, xhr } = openStream({ signal: controller.signal });
    controller.abort();
    await assert.rejects(done, RequestCancelledError);
    assert.equal(xhr.aborted, true);
  });
});
