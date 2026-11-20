import 'package:flutter_test/flutter_test.dart';
import 'package:supabase_chatbot/src/chat/chat_controller.dart';
import 'package:supabase_chatbot/src/chat/chat_history_store.dart';
import 'package:supabase_chatbot/src/serve/run_request.dart';
import 'package:supabase_chatbot/src/serve/run_update.dart';
import 'package:supabase_chatbot/src/serve/serve_client.dart';

class InMemoryHistoryStore implements ChatHistoryStore {
  final Map<String, List<StoredMessage>> sessions = {};

  @override
  Future<String?> latestSessionId() async => sessions.keys.lastOrNull;

  @override
  Future<String> startSession(String title) async {
    final sessionId = 'session-${sessions.length + 1}';
    sessions[sessionId] = [];
    return sessionId;
  }

  @override
  Future<List<StoredMessage>> listMessages(String sessionId) async => [
    ...sessions[sessionId]!,
  ];

  @override
  Future<void> addMessage(String sessionId, StoredMessage message) async =>
      sessions[sessionId]!.add(message);
}

/// Plays one scripted stream per run and records the requests.
class ScriptedRuns {
  ScriptedRuns(this.scripts);
  final List<Stream<RunUpdate> Function()> scripts;
  final List<RunRequest> requests = [];

  Stream<RunUpdate> call(RunRequest request) {
    requests.add(request);
    return scripts[requests.length - 1]();
  }
}

Stream<RunUpdate> succeeded(String text) => Stream.fromIterable([
  const ToolActivity(callId: 'c1', isRunning: true),
  const ToolActivity(callId: 'c1', isRunning: false),
  for (final word in text.split(' ')) AnswerDelta('$word '),
  const RunFinished(RunOutcome.succeeded),
]);

void main() {
  late InMemoryHistoryStore store;

  ChatController controllerFor(ScriptedRuns runs) => ChatController(
    runStreamer: runs.call,
    historyStore: store,
    clock: () => DateTime(2026, 11, 20),
  );

  setUp(() => store = InMemoryHistoryStore());

  test('streams a reply and saves both messages in a new session', () async {
    final runs = ScriptedRuns([() => succeeded('Hello Ada')]);
    final controller = controllerFor(runs);
    await controller.sendMessage('  hi  ');

    expect(controller.messages.map((m) => '${m.role}:${m.text.trim()}'), [
      'user:hi',
      'assistant:Hello Ada',
    ]);
    expect(controller.messages.last.status, MessageStatus.complete);
    expect(controller.isToolRunning, isFalse);
    expect(controller.sessionId, 'session-1');
    expect(store.sessions['session-1']!.map((m) => m.role), [
      'user',
      'assistant',
    ]);
    expect(runs.requests.single.history, isEmpty);
    expect(runs.requests.single.sessionId, 'session-1');
  });

  test(
    'sends earlier complete turns as history, without the current message',
    () async {
      final runs = ScriptedRuns([
        () => succeeded('one'),
        () => succeeded('two'),
      ]);
      final controller = controllerFor(runs);
      await controller.sendMessage('first');
      await controller.sendMessage('second');

      final history = runs.requests.last.history;
      expect(history.map((turn) => turn.role), ['user', 'assistant']);
      expect(history.first.content, 'first');
      expect(runs.requests.last.message, 'second');
    },
  );

  test(
    'a dropped stream keeps the partial text, is not saved, and can be retried',
    () async {
      final runs = ScriptedRuns([
        () async* {
          yield const AnswerDelta('Partial');
          throw const RunInterruptedException('reset');
        },
        () => succeeded('Full answer'),
      ]);
      final controller = controllerFor(runs);
      await controller.sendMessage('question');

      expect(controller.messages.last.text, 'Partial');
      expect(controller.messages.last.status, MessageStatus.interrupted);
      expect(controller.canRetry, isTrue);
      expect(store.sessions['session-1']!.map((m) => m.role), ['user']);

      await controller.retryLastReply();
      expect(controller.messages, hasLength(2));
      expect(controller.messages.last.text.trim(), 'Full answer');
      expect(runs.requests.last.message, 'question');
      expect(runs.requests.last.history, isEmpty);
      expect(store.sessions['session-1']!.map((m) => m.role), [
        'user',
        'assistant',
      ]);
    },
  );

  test(
    'a stream that ends without a terminal event counts as interrupted',
    () async {
      final runs = ScriptedRuns([
        () => Stream.value(const AnswerDelta('Half')),
      ]);
      final controller = controllerFor(runs);
      await controller.sendMessage('q');
      expect(controller.messages.last.status, MessageStatus.interrupted);
    },
  );

  test(
    'a token refused after refresh asks the user to sign in again',
    () async {
      final runs = ScriptedRuns([
        () => Stream.error(const RunStartException('expired', statusCode: 401)),
      ]);
      final controller = controllerFor(runs);
      await controller.sendMessage('q');
      expect(controller.needsSignIn, isTrue);
      expect(controller.messages.last.status, MessageStatus.failed);
    },
  );

  test('run_failed shows the server error', () async {
    final runs = ScriptedRuns([
      () => Stream.value(
        const RunFinished(
          RunOutcome.failed,
          errorMessage: 'invalid_input: too long',
        ),
      ),
    ]);
    final controller = controllerFor(runs);
    await controller.sendMessage('q');
    expect(controller.messages.last.errorText, 'invalid_input: too long');
    expect(controller.canRetry, isTrue);
  });

  test(
    'loads the latest session and rejects over-long messages locally',
    () async {
      store.sessions['old'] = [
        const StoredMessage(role: 'user', content: 'a'),
        const StoredMessage(role: 'assistant', content: 'b'),
      ];
      final runs = ScriptedRuns([]);
      final controller = controllerFor(runs);
      await controller.loadLatestSession();
      expect(controller.sessionId, 'old');
      expect(controller.messages.map((m) => m.text), ['a', 'b']);

      await controller.sendMessage('x' * (RunLimits.maxMessageChars + 1));
      expect(runs.requests, isEmpty);
      expect(controller.noticeText, contains('4000'));
    },
  );
}
