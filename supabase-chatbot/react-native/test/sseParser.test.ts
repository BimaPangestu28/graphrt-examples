import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SseParser, type SseEvent } from '../src/sse/sseParser.ts';
import { interpretServeEvent } from '../src/sse/serveEvents.ts';

/** A trimmed copy of a real `graphrt serve` stream (docs/investigations, section 4). */
const RECORDED_STREAM = [
  'event: run_started',
  'data: {"type":"run_started","run_id":"run-18e9ab5b14ee9900-1","resumed":false}',
  '',
  'event: response',
  'data: {"node_id":"answer","text":"Halo","is_final":false}',
  '',
  'event: node_chunk',
  'data: {"type":"node_chunk","frame":"","node_id":"llm","exec_id":"x","field":"text","chunk":"Halo"}',
  '',
  'event: response',
  'data: {"node_id":"answer","text":"! Saldo kamu Rp120.000.","is_final":false}',
  '',
  ':keep-alive',
  '',
  'event: response',
  'data: {"node_id":"answer","text":"","is_final":true}',
  '',
  'event: run_succeeded',
  'data: {"type":"run_succeeded","outputs":{"answer":"Halo! Saldo kamu Rp120.000."},"elapsed_ms":162}',
  '',
  '',
].join('\n');

function parseInChunks(stream: string, chunkSize: number): SseEvent[] {
  const parser = new SseParser();
  const events: SseEvent[] = [];
  for (let offset = 0; offset < stream.length; offset += chunkSize) {
    events.push(...parser.push(stream.slice(offset, offset + chunkSize)));
  }
  return events;
}

describe('SseParser', () => {
  it('parses a complete event', () => {
    const events = new SseParser().push('event: response\ndata: {"text":"Hi"}\n\n');
    assert.deepEqual(events, [{ type: 'response', data: '{"text":"Hi"}' }]);
  });

  it('gives the same events however the stream is chunked', () => {
    const whole = parseInChunks(RECORDED_STREAM, RECORDED_STREAM.length);
    assert.equal(whole.length, 6);
    for (const chunkSize of [1, 2, 3, 7, 64]) {
      assert.deepEqual(parseInChunks(RECORDED_STREAM, chunkSize), whole, `chunk size ${chunkSize}`);
    }
  });

  it('accepts CRLF and CR line endings, also split between chunks', () => {
    const crlf = 'event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\r';
    for (const chunkSize of [1, 2, crlf.length]) {
      assert.deepEqual(parseInChunks(crlf, chunkSize), [
        { type: 'a', data: '1' },
        { type: 'b', data: '2' },
      ]);
    }
  });

  it('joins multi-line data with newlines and strips only one leading space', () => {
    const events = new SseParser().push('data:  first\ndata:second\n\n');
    assert.deepEqual(events, [{ type: 'message', data: ' first\nsecond' }]);
  });

  it('ignores comments, unknown fields and events without data', () => {
    const events = new SseParser().push(': ping\nretry: 10\nevent: lonely\n\nfoo\nevent: x\ndata\n\n');
    assert.deepEqual(events, [{ type: 'x', data: '' }]);
  });

  it('keeps the last event id', () => {
    const events = new SseParser().push('id: 7\ndata: a\n\ndata: b\n\n');
    assert.deepEqual(events, [
      { type: 'message', data: 'a', id: '7' },
      { type: 'message', data: 'b', id: '7' },
    ]);
  });

  it('drops an unterminated event at the end of the stream', () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push('event: response\ndata: {"text":"partial"}\n'), []);
    parser.end();
    assert.deepEqual(parser.push('\n'), []);
  });
});

describe('interpretServeEvent', () => {
  it('rebuilds the answer of a recorded stream from response events', () => {
    const interpreted = parseInChunks(RECORDED_STREAM, 5).map(interpretServeEvent);
    const answer = interpreted.map((event) => (event.kind === 'text' ? event.text : '')).join('');
    assert.equal(answer, 'Halo! Saldo kamu Rp120.000.');
    assert.equal(interpreted.at(-1)?.kind, 'run_succeeded');
  });

  it('maps tool progress to start / finish by call id', () => {
    const started = interpretServeEvent({
      type: 'node_progress',
      data: '{"type":"node_progress","node_id":"agent","name":"tool_call","data":{"id":"c1","name":"supabase/call_function","arguments":{}}}',
    });
    const finished = interpretServeEvent({
      type: 'node_progress',
      data: '{"type":"node_progress","node_id":"agent","name":"tool_result","data":{"id":"c1","name":"supabase/call_function","is_error":false}}',
    });
    const agentStep = interpretServeEvent({ type: 'node_progress', data: '{"name":"agent_step","data":{"step":1}}' });
    assert.deepEqual(started, { kind: 'tool_started', callId: 'c1', toolName: 'supabase/call_function' });
    assert.deepEqual(finished, { kind: 'tool_finished', callId: 'c1' });
    assert.deepEqual(agentStep, { kind: 'ignored' });
  });

  it('reads run_failed error and error_type', () => {
    const failed = interpretServeEvent({
      type: 'run_failed',
      data: '{"type":"run_failed","error":"invalid_input: input `message` is required","error_type":"invalid_input"}',
    });
    assert.deepEqual(failed, {
      kind: 'run_failed',
      error: 'invalid_input: input `message` is required',
      errorType: 'invalid_input',
    });
  });

  it('maps the other terminal events and ignores malformed or empty data', () => {
    assert.equal(interpretServeEvent({ type: 'run_aborted', data: '{}' }).kind, 'run_aborted');
    assert.equal(interpretServeEvent({ type: 'run_paused', data: '{}' }).kind, 'run_paused');
    assert.equal(interpretServeEvent({ type: 'response', data: 'not json' }).kind, 'ignored');
    assert.equal(interpretServeEvent({ type: 'response', data: '{"text":""}' }).kind, 'ignored');
    assert.deepEqual(interpretServeEvent({ type: 'run_failed', data: 'oops' }), {
      kind: 'run_failed',
      error: 'The run failed.',
      errorType: '',
    });
  });
});
