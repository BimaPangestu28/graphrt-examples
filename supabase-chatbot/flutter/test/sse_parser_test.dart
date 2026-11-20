import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:supabase_chatbot/src/serve/run_update.dart';
import 'package:supabase_chatbot/src/serve/sse_parser.dart';

/// A trimmed real stream from `graphrt serve` (docs/investigations section 4).
const String recordedStream =
    'event: run_started\n'
    'data: {"type":"run_started","run_id":"run-1","resumed":false}\n\n'
    'event: response\n'
    'data: {"node_id":"answer","text":"Halo","is_final":false}\n\n'
    'event: node_chunk\n'
    'data: {"type":"node_chunk","node_id":"llm","field":"text","chunk":"Halo"}\n\n'
    'event: response\n'
    'data: {"node_id":"answer","text":"! Saldo kamu Rp120.000.","is_final":false}\n\n'
    'event: response\n'
    'data: {"node_id":"answer","text":"","is_final":true}\n\n'
    'event: run_succeeded\n'
    'data: {"type":"run_succeeded","outputs":{"answer":"Halo! Saldo kamu Rp120.000."}}\n\n';

List<SseEvent> parseAll(Iterable<String> chunks) {
  final parser = SseParser();
  return [for (final chunk in chunks) ...parser.addChunk(chunk)];
}

void main() {
  group('SseParser', () {
    test('parses a recorded serve stream into typed events', () {
      final events = parseAll([recordedStream]);
      expect(events.map((event) => event.type), [
        'run_started',
        'response',
        'node_chunk',
        'response',
        'response',
        'run_succeeded',
      ]);
      expect(events[1].jsonData?['text'], 'Halo');
    });

    test('gives the same events whatever the chunk boundaries are', () {
      final expected = parseAll([recordedStream]).map((e) => '$e').toList();
      for (final chunkSize in [1, 2, 3, 7, 64]) {
        final chunks = [
          for (var start = 0; start < recordedStream.length; start += chunkSize)
            recordedStream.substring(
              start,
              (start + chunkSize).clamp(0, recordedStream.length),
            ),
        ];
        expect(
          parseAll(chunks).map((e) => '$e'),
          expected,
          reason: '$chunkSize',
        );
      }
    });

    test('accepts CRLF and CR line endings, also split between chunks', () {
      final events = parseAll([
        'event: a\r',
        '\ndata: 1\r\n\r',
        '\nevent: b\rdata: 2\r\r',
      ]);
      expect(events.map((event) => '${event.type}=${event.data}'), [
        'a=1',
        'b=2',
      ]);
    });

    test('joins multi-line data and drops one leading space only', () {
      final events = parseAll(['data:  two spaces\ndata:none\n\n']);
      expect(events.single.data, ' two spaces\nnone');
      expect(events.single.type, 'message');
    });

    test('ignores comments, unknown fields and events without data', () {
      final events = parseAll([
        ': keep-alive\n\nevent: ping\n\nretry: 10\nfoo: bar\ndata: x\n\n',
      ]);
      expect(events.single.data, 'x');
      expect(events.single.type, 'message');
    });

    test('keeps a cut event buffered and reports it as partial', () {
      final parser = SseParser();
      expect(parser.addChunk('event: response\ndata: {"text":"Hal'), isEmpty);
      expect(parser.hasPartialEvent, isTrue);
    });

    test('parseSseBytes decodes UTF-8 split inside a character', () async {
      final bytes = utf8.encode('data: {"text":"Rp120.000 — ok 👋"}\n\n');
      final byteChunks = [
        for (final byte in bytes) [byte],
      ];
      final events = await parseSseBytes(Stream.fromIterable(byteChunks))
          .toList();
      expect(events.single.jsonData?['text'], 'Rp120.000 — ok 👋');
    });

    test('jsonData is null for non-JSON data', () {
      expect(const SseEvent(type: 'x', data: 'not json').jsonData, isNull);
    });
  });

  group('toRunUpdate', () {
    test('maps response text, skipping empty final chunks', () {
      final updates = parseAll([recordedStream])
          .map(toRunUpdate)
          .whereType<RunUpdate>()
          .toList();
      expect(
        updates.whereType<AnswerDelta>().map((delta) => delta.text).join(),
        'Halo! Saldo kamu Rp120.000.',
      );
      expect((updates.last as RunFinished).outcome, RunOutcome.succeeded);
      expect(updates, hasLength(3));
    });

    test('maps run_failed with its error message', () {
      final update = toRunUpdate(
        const SseEvent(
          type: 'run_failed',
          data: '{"type":"run_failed","error":"invalid_input: input `message` is required","error_type":"invalid_input"}',
        ),
      );
      expect(
        update,
        isA<RunFinished>().having(
          (f) => f.outcome,
          'outcome',
          RunOutcome.failed,
        ),
      );
      expect((update as RunFinished).errorMessage, contains('invalid_input'));
    });

    test('maps aborted and paused runs as terminal', () {
      expect(
        (toRunUpdate(
          const SseEvent(type: 'run_aborted', data: '{}'),
        ) as RunFinished).outcome,
        RunOutcome.aborted,
      );
      expect(
        (toRunUpdate(
          const SseEvent(type: 'run_paused', data: '{}'),
        ) as RunFinished).outcome,
        RunOutcome.paused,
      );
    });

    test('maps node_progress tool_call and tool_result to tool activity', () {
      final started = toRunUpdate(
        const SseEvent(
          type: 'node_progress',
          data: '{"type":"node_progress","node_id":"agent","name":"tool_call","data":{"id":"call_1","name":"supabase/call_function"}}',
        ),
      );
      final finished = toRunUpdate(
        const SseEvent(
          type: 'node_progress',
          data: '{"type":"node_progress","node_id":"agent","name":"tool_result","data":{"id":"call_1","is_error":false}}',
        ),
      );
      expect(
        started,
        isA<ToolActivity>().having((a) => a.isRunning, 'running', isTrue),
      );
      expect(
        finished,
        isA<ToolActivity>().having((a) => a.callId, 'id', 'call_1'),
      );
      expect((finished as ToolActivity).isRunning, isFalse);
    });

    test('ignores other progress and other event types', () {
      expect(
        toRunUpdate(
          const SseEvent(
            type: 'node_progress',
            data: '{"name":"agent_step","data":{}}',
          ),
        ),
        isNull,
      );
      expect(
        toRunUpdate(const SseEvent(type: 'node_started', data: '{}')),
        isNull,
      );
    });
  });
}
