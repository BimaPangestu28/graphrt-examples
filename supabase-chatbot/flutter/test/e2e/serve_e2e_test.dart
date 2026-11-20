/// End-to-end tests of the client against a real `graphrt serve`.
///
/// Run through `tool/e2e/run_against_serve.sh`, which starts serve (with the
/// supabase-chatbot workflow, mock upstreams and `--user-rate-limit 3`), a
/// fault-injecting proxy, and passes tokens in `E2E_*` variables. Without
/// them (plain `flutter test`) every test here is skipped.
@Tags(['e2e'])
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:supabase_chatbot/src/chat/chat_controller.dart';
import 'package:supabase_chatbot/src/chat/chat_history_store.dart';
import 'package:supabase_chatbot/src/serve/retry_policy.dart';
import 'package:supabase_chatbot/src/serve/run_request.dart';
import 'package:supabase_chatbot/src/serve/run_update.dart';
import 'package:supabase_chatbot/src/serve/serve_client.dart';

final Map<String, String> environment = Platform.environment;
final String? skipReason = environment['E2E_SERVE_URL'] == null
    ? 'set by tool/e2e/run_against_serve.sh'
    : null;

/// The mock OpenAI upstream answers with the mock Supabase profile name.
const String expectedAnswer = 'Your display name is Ada.';

String env(String name) => environment[name]!;

RunRequest question() => RunRequest(
  message: 'What is my display name?',
  history: const [
    ChatTurn(role: 'user', content: 'Hi'),
    ChatTurn(role: 'assistant', content: 'Hello!'),
  ],
  today: DateTime.now(),
  sessionId: 's-e2e',
);

/// Hands out [initialToken], then [refreshedToken] once a refresh is forced.
class RecordingTokens {
  RecordingTokens(this.initialToken, {String? refreshedToken})
    : refreshedToken = refreshedToken ?? initialToken;
  final String initialToken;
  final String refreshedToken;
  int refreshCount = 0;
  int callCount = 0;

  Future<String> call({bool forceRefresh = false}) async {
    callCount++;
    if (forceRefresh) refreshCount++;
    return refreshCount > 0 ? refreshedToken : initialToken;
  }
}

ServeClient clientFor(
  String baseUrl,
  RecordingTokens tokens, {
  RetryPolicy? retryPolicy,
  DelayFunction? delay,
  Duration idleTimeout = const Duration(seconds: 90),
}) => ServeClient(
  serveUrl: Uri.parse(baseUrl),
  workflowName: 'agent',
  accessTokenProvider: tokens.call,
  retryPolicy: retryPolicy,
  delay: delay,
  idleTimeout: idleTimeout,
);

String answerOf(List<RunUpdate> updates) =>
    updates.whereType<AnswerDelta>().map((delta) => delta.text).join();

class InMemoryHistoryStore implements ChatHistoryStore {
  final List<StoredMessage> savedMessages = [];

  @override
  Future<String?> latestSessionId() async => null;

  @override
  Future<String> startSession(String title) async => 's-e2e';

  @override
  Future<List<StoredMessage>> listMessages(String sessionId) async => [];

  @override
  Future<void> addMessage(String sessionId, StoredMessage message) async =>
      savedMessages.add(message);
}

void main() {
  group('against graphrt serve', skip: skipReason, () {
    test('streams the answer token by token with tool activity', () async {
      final tokens = RecordingTokens(env('E2E_JWT_STREAM'));
      final updates = await clientFor(
        env('E2E_SERVE_URL'),
        tokens,
      ).streamRun(question()).toList();

      expect(answerOf(updates), expectedAnswer);
      expect(
        updates.whereType<AnswerDelta>().length,
        greaterThan(1),
        reason: 'the answer arrives in several response events',
      );
      final toolActivity = updates.whereType<ToolActivity>().toList();
      expect(toolActivity.map((activity) => activity.isRunning), [true, false]);
      expect((updates.last as RunFinished).outcome, RunOutcome.succeeded);
      expect(tokens.refreshCount, 0);
    });

    test('expired token: 401, refresh, retry once, then streams', () async {
      final tokens = RecordingTokens(
        env('E2E_JWT_REFRESH_EXPIRED'),
        refreshedToken: env('E2E_JWT_REFRESH_VALID'),
      );
      final updates = await clientFor(
        env('E2E_SERVE_URL'),
        tokens,
      ).streamRun(question()).toList();

      expect(answerOf(updates), expectedAnswer);
      expect(tokens.refreshCount, 1);
      expect(tokens.callCount, 2);
    });

    test('token still refused after refresh: asks to sign in', () async {
      final tokens = RecordingTokens(env('E2E_JWT_REFRESH_EXPIRED'));
      await expectLater(
        clientFor(env('E2E_SERVE_URL'), tokens).streamRun(question()).toList(),
        throwsA(
          isA<RunStartException>().having(
            (error) => error.needsSignIn,
            'needsSignIn',
            isTrue,
          ),
        ),
      );
      expect(tokens.callCount, 2, reason: 'exactly one refresh + retry');
    });

    test('429: waits Retry-After from serve, then reports the limit', () async {
      final tokens = RecordingTokens(env('E2E_JWT_LIMIT'));
      final client = clientFor(env('E2E_SERVE_URL'), tokens);
      for (var run = 0; run < 3; run++) {
        expect(
          answerOf(await client.streamRun(question()).toList()),
          expectedAnswer,
        );
      }
      final waits = <Duration>[];
      final limitedClient = clientFor(
        env('E2E_SERVE_URL'),
        tokens,
        retryPolicy: RetryPolicy(maxAttempts: 2),
        delay: (duration) async => waits.add(duration),
      );
      await expectLater(
        limitedClient.streamRun(question()).toList(),
        throwsA(
          isA<RunStartException>()
              .having((error) => error.statusCode, 'statusCode', 429)
              .having(
                (error) => error.message,
                'message',
                contains('Try again in'),
              ),
        ),
      );
      expect(waits, hasLength(1));
      expect(waits.single.inSeconds, inInclusiveRange(1, 60));
    });

    test('dropped mid-stream: partial text kept, Retry completes it', () async {
      final tokens = RecordingTokens(env('E2E_JWT_DROP'));
      final cutClient = clientFor('${env('E2E_PROXY_URL')}cut/', tokens);
      final directClient = clientFor(env('E2E_SERVE_URL'), tokens);
      var runCount = 0;
      final historyStore = InMemoryHistoryStore();
      final controller = ChatController(
        runStreamer: (request) =>
            (runCount++ == 0 ? cutClient : directClient).streamRun(request),
        historyStore: historyStore,
      );

      await controller.sendMessage('What is my display name?');
      final partialReply = controller.messages.last;
      expect(partialReply.status, MessageStatus.interrupted);
      expect(partialReply.text, isNotEmpty);
      expect(expectedAnswer, startsWith(partialReply.text));
      expect(controller.canRetry, isTrue);
      expect(historyStore.savedMessages.map((message) => message.role), [
        'user',
      ]);

      await controller.retryLastReply();
      expect(controller.messages, hasLength(2));
      expect(controller.messages.last.text, expectedAnswer);
      expect(controller.messages.last.status, MessageStatus.complete);
      expect(historyStore.savedMessages.map((message) => message.role), [
        'user',
        'assistant',
      ]);
    });

    test(
      'stalled stream: idle timeout interrupts after the partial text',
      () async {
        final tokens = RecordingTokens(env('E2E_JWT_STALL'));
        final received = <RunUpdate>[];
        final stopwatch = Stopwatch()..start();
        await expectLater(
          clientFor(
            '${env('E2E_PROXY_URL')}stall/',
            tokens,
            idleTimeout: const Duration(seconds: 2),
          ).streamRun(question()).forEach(received.add),
          throwsA(isA<RunInterruptedException>()),
        );
        expect(stopwatch.elapsed, lessThan(const Duration(seconds: 10)));
        expect(answerOf(received), isNotEmpty);
      },
    );
  });
}
