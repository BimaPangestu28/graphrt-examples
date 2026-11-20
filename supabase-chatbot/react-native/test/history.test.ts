import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_MESSAGE_CHARS,
  buildRunBody,
  formatLocalDate,
  selectRecentHistory,
  utf8ByteLength,
  validateMessage,
  type HistoryMessage,
} from '../src/chat/history.ts';
import { buildRunUrl, parseConfig } from '../src/config.ts';

const conversation = (turns: number): HistoryMessage[] =>
  Array.from({ length: turns * 2 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
  }));

describe('history', () => {
  it('keeps the last N turns, oldest first', () => {
    const recent = selectRecentHistory(conversation(5), 2);
    assert.deepEqual(
      recent.map((message) => message.content),
      ['message 6', 'message 7', 'message 8', 'message 9'],
    );
    assert.deepEqual(selectRecentHistory(conversation(1), 8).length, 2);
    assert.deepEqual(selectRecentHistory(conversation(3), 0), []);
  });

  it('builds the serve body with inputs and sys.history, without sys.user_id', () => {
    const body = JSON.parse(
      buildRunBody({ message: 'Hi', sessionId: 's-1', history: conversation(1), today: '2026-11-20' }),
    );
    assert.deepEqual(body, {
      stream: true,
      inputs: { message: 'Hi', session_id: 's-1' },
      sys: { history: conversation(1), today: '2026-11-20' },
    });
    const withoutSession = JSON.parse(buildRunBody({ message: 'Hi', history: [], today: '2026-11-20' }));
    assert.deepEqual(withoutSession.inputs, { message: 'Hi' });
  });

  it('drops the oldest history until the body fits the limit', () => {
    const history = conversation(4).map((message) => ({ ...message, content: 'é'.repeat(500) }));
    const body = buildRunBody({ message: 'Hi', history, today: '2026-11-20' }, 2500);
    assert.ok(utf8ByteLength(body) <= 2500);
    const kept = JSON.parse(body).sys.history as HistoryMessage[];
    assert.equal(kept.length, 2);
    assert.deepEqual(kept, history.slice(-2));
  });

  it('validates message length and emptiness', () => {
    assert.ok(validateMessage('   '));
    assert.ok(validateMessage('x'.repeat(MAX_MESSAGE_CHARS + 1)));
    assert.equal(validateMessage('x'.repeat(MAX_MESSAGE_CHARS)), undefined);
  });

  it('counts UTF-8 bytes and formats local dates', () => {
    assert.equal(utf8ByteLength('aé€😀'), 1 + 2 + 3 + 4);
    assert.equal(formatLocalDate(new Date(2026, 0, 5)), '2026-01-05');
  });
});

describe('config', () => {
  const valid = {
    EXPO_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
    EXPO_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_x',
    EXPO_PUBLIC_SERVE_URL: 'http://10.0.2.2:8080/',
  };

  it('applies defaults and builds the run URL', () => {
    const result = parseConfig(valid);
    assert.ok(result.ok);
    assert.equal(result.config.workflowName, 'agent');
    assert.equal(result.config.historyTurns, 8);
    assert.equal(buildRunUrl(result.config), 'http://10.0.2.2:8080/v1/workflows/agent/runs');
  });

  it('lists every problem', () => {
    const result = parseConfig({ EXPO_PUBLIC_SERVE_URL: 'serve', EXPO_PUBLIC_HISTORY_TURNS: 'many' });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? 0 : result.problems.length, 4);
  });
});
