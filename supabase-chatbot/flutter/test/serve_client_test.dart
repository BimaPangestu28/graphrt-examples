import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:supabase_chatbot/src/serve/retry_policy.dart';
import 'package:supabase_chatbot/src/serve/run_request.dart';
import 'package:supabase_chatbot/src/serve/run_update.dart';
import 'package:supabase_chatbot/src/serve/serve_client.dart';

const String okStream =
    'event: response\ndata: {"node_id":"answer","text":"Hi ","is_final":false}\n\n'
    'event: node_progress\ndata: {"name":"tool_call","data":{"id":"c1"}}\n\n'
    'event: response\ndata: {"node_id":"answer","text":"Ada","is_final":false}\n\n'
    'event: run_succeeded\ndata: {"type":"run_succeeded"}\n\n';

http.StreamedResponse sse(String body) => http.StreamedResponse(
  Stream.value(utf8.encode(body)),
  200,
  headers: {'content-type': 'text/event-stream'},
);

http.StreamedResponse jsonError(
  int code,
  String message, {
  Map<String, String> headers = const {},
}) => http.StreamedResponse(
  Stream.value(utf8.encode(jsonEncode({'error': message}))),
  code,
  headers: headers,
);

/// A fake serve that answers each attempt with the next scripted response.
class ScriptedServe {
  ScriptedServe(this.responses);
  final List<FutureOr<http.StreamedResponse> Function()> responses;
  final List<http.BaseRequest> requests = [];
  final List<String> bodies = [];

  MockClient get client => MockClient.streaming((request, bodyStream) async {
    requests.add(request);
    bodies.add(await bodyStream.bytesToString());
    return responses[requests.length - 1]();
  });
}

class TokenSource {
  int refreshCount = 0;
  Future<String> call({bool forceRefresh = false}) async {
    if (forceRefresh) refreshCount++;
    return 'jwt-$refreshCount';
  }
}

void main() {
  final request = RunRequest(
    message: ' What is my name? ',
    history: const [
      ChatTurn(role: 'user', content: 'Hi'),
      ChatTurn(role: 'assistant', content: 'Hello!'),
    ],
    today: DateTime(2026, 11, 20),
    sessionId: 's-1',
  );
  late List<Duration> sleeps;
  late TokenSource tokens;

  ServeClient clientFor(ScriptedServe serve) => ServeClient(
    serveUrl: Uri.parse('http://serve.test/base/'),
    workflowName: 'agent',
    accessTokenProvider: tokens.call,
    createHttpClient: () => serve.client,
    retryPolicy: RetryPolicy(random: _FixedRandom()),
    delay: (duration) async => sleeps.add(duration),
  );

  setUp(() {
    sleeps = [];
    tokens = TokenSource();
  });

  test('posts the contract body and header, then streams updates', () async {
    final serve = ScriptedServe([() => sse(okStream)]);
    final updates = await clientFor(serve).streamRun(request).toList();

    final sent = serve.requests.single;
    expect(
      sent.url.toString(),
      'http://serve.test/base/v1/workflows/agent/runs',
    );
    expect(sent.headers['x-user-authorization'], 'Bearer jwt-0');
    expect(sent.headers.containsKey('authorization'), isFalse);
    expect(sent.headers['content-type'], startsWith('application/json'));
    expect(jsonDecode(serve.bodies.single), {
      'stream': true,
      'inputs': {'message': 'What is my name?', 'session_id': 's-1'},
      'sys': {
        'history': [
          {'role': 'user', 'content': 'Hi'},
          {'role': 'assistant', 'content': 'Hello!'},
        ],
        'today': '2026-11-20',
      },
    });
    expect(
      updates.whereType<AnswerDelta>().map((d) => d.text).join(),
      'Hi Ada',
    );
    expect(updates.whereType<ToolActivity>(), hasLength(1));
    expect(updates.last, isA<RunFinished>());
  });

  test(
    'expired token: refreshes and retries once with the new token',
    () async {
      final serve = ScriptedServe([
        () => jsonError(401, 'invalid user token'),
        () => sse(okStream),
      ]);
      final updates = await clientFor(serve).streamRun(request).toList();
      expect(updates.last, isA<RunFinished>());
      expect(tokens.refreshCount, 1);
      expect(serve.requests.map((r) => r.headers['x-user-authorization']), [
        'Bearer jwt-0',
        'Bearer jwt-1',
      ]);
      expect(sleeps, isEmpty);
    },
  );

  test('token refused twice: fails asking to sign in again', () async {
    final serve = ScriptedServe([
      () => jsonError(401, 'a'),
      () => jsonError(401, 'b'),
    ]);
    await expectLater(
      clientFor(serve).streamRun(request).toList(),
      throwsA(
        isA<RunStartException>().having(
          (e) => e.needsSignIn,
          'needsSignIn',
          isTrue,
        ),
      ),
    );
    expect(serve.requests, hasLength(2));
  });

  test(
    'a retry after an error response uses a fresh connection pool',
    () async {
      final serve = ScriptedServe([
        () => jsonError(401, 'expired'),
        () => sse(okStream),
      ]);
      var createdClients = 0;
      final client = ServeClient(
        serveUrl: Uri.parse('http://serve.test/'),
        workflowName: 'agent',
        accessTokenProvider: tokens.call,
        createHttpClient: () {
          createdClients++;
          return serve.client;
        },
        delay: (duration) async => sleeps.add(duration),
      );
      await client.streamRun(request).toList();
      expect(createdClients, 2);
    },
  );

  test('rate limited: waits Retry-After, then succeeds', () async {
    final serve = ScriptedServe([
      () =>
          jsonError(429, 'rate limit exceeded', headers: {'retry-after': '2'}),
      () => sse(okStream),
    ]);
    await clientFor(serve).streamRun(request).toList();
    expect(sleeps, [const Duration(seconds: 2)]);
  });

  test('network errors: backs off and gives up after 4 attempts', () async {
    final serve = ScriptedServe(
      List.filled(4, () => throw http.ClientException('refused')),
    );
    await expectLater(
      clientFor(serve).streamRun(request).toList(),
      throwsA(isA<RunStartException>()),
    );
    expect(serve.requests, hasLength(4));
    expect(sleeps, [
      const Duration(milliseconds: 250),
      const Duration(milliseconds: 500),
      const Duration(milliseconds: 1000),
    ]);
  });

  test('plain-text 413 body is reported without retrying', () async {
    final serve = ScriptedServe([
      () => http.StreamedResponse(
        Stream.value(utf8.encode('Payload Too Large')),
        413,
      ),
    ]);
    await expectLater(
      clientFor(serve).streamRun(request).toList(),
      throwsA(
        isA<RunStartException>().having(
          (e) => e.message,
          'message',
          'Payload Too Large',
        ),
      ),
    );
    expect(serve.requests, hasLength(1));
  });

  test('stream closed before the end event: yields the partial text, then interrupts', () async {
    final serve = ScriptedServe([
      () => sse(
        'event: response\ndata: {"text":"Partial ","is_final":false}\n\n',
      ),
    ]);
    final received = <RunUpdate>[];
    await expectLater(
      clientFor(serve).streamRun(request).forEach(received.add),
      throwsA(isA<RunInterruptedException>()),
    );
    expect((received.single as AnswerDelta).text, 'Partial ');
    expect(
      serve.requests,
      hasLength(1),
      reason: 'a started run is never re-sent automatically',
    );
  });

  test(
    'connection error mid-stream: interrupts after the partial text',
    () async {
      final serve = ScriptedServe([
        () => http.StreamedResponse(
          Stream.fromIterable([
            utf8.encode('event: response\ndata: {"text":"Par"}\n\n'),
          ]).followedBy(Stream.error(http.ClientException('connection reset'))),
          200,
        ),
      ]);
      final received = <RunUpdate>[];
      await expectLater(
        clientFor(serve).streamRun(request).forEach(received.add),
        throwsA(isA<RunInterruptedException>()),
      );
      expect(received.single, isA<AnswerDelta>());
    },
  );

  test('run_failed in the stream is a normal end, not an exception', () async {
    final serve = ScriptedServe([
      () => sse(
        'event: run_failed\ndata: {"error":"invalid_input: too long","error_type":"invalid_input"}\n\n',
      ),
    ]);
    final updates = await clientFor(serve).streamRun(request).toList();
    expect(
      (updates.single as RunFinished).errorMessage,
      'invalid_input: too long',
    );
  });

  test('history is trimmed to the last 16 messages and to the body limit', () {
    final longHistory = [
      for (var index = 0; index < 30; index++)
        ChatTurn(
          role: index.isEven ? 'user' : 'assistant',
          content: '$index ${'x' * 7000}',
        ),
    ];
    final body = encodeRunBody(
      RunRequest(message: 'hi', history: longHistory, today: DateTime(2026)),
    );
    final history = (jsonDecode(utf8.decode(body))['sys']['history'] as List)
        .cast<Map>();
    expect(body.length, lessThanOrEqualTo(RunLimits.maxBodyBytes));
    expect(history.length, lessThan(16));
    expect(history.last['content'], startsWith('29 '));
  });

  test('rejects empty or over-long messages before sending', () {
    expect(
      () => encodeRunBody(
        RunRequest(message: '  ', history: const [], today: DateTime(2026)),
      ),
      throwsArgumentError,
    );
    expect(
      () => encodeRunBody(
        RunRequest(
          message: 'x' * 4001,
          history: const [],
          today: DateTime(2026),
        ),
      ),
      throwsArgumentError,
    );
  });
}

extension<T> on Stream<T> {
  Stream<T> followedBy(Stream<T> next) async* {
    yield* this;
    yield* next;
  }
}

class _FixedRandom implements Random {
  @override
  int nextInt(int max) => 0;
  @override
  bool nextBool() => false;
  @override
  double nextDouble() => 0;
}
