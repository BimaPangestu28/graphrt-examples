/// Streams a chatbot run from `graphrt serve`.
///
/// Sends the user's Supabase access token in `X-User-Authorization` (never
/// `Authorization`, which belongs to the serve API key that stays on the
/// server). Retries failed *starts* per [RetryPolicy]: refresh the token once
/// on 401, honor `Retry-After` on 429, back off on network errors and 5xx.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'retry_policy.dart';
import 'run_request.dart';
import 'run_update.dart';
import 'sse_parser.dart';

/// Returns the current access token; refreshes the session first when
/// [forceRefresh] is set or the token has expired.
typedef AccessTokenProvider = Future<String> Function({bool forceRefresh});

/// Waits [delay]; injectable so tests do not sleep.
typedef DelayFunction = Future<void> Function(Duration delay);

/// The run could not be started (after the retries the policy allowed).
class RunStartException implements Exception {
  const RunStartException(this.message, {this.statusCode});
  final String message;
  final int? statusCode;

  /// The token was refused even after a refresh: the user must sign in again.
  bool get needsSignIn => statusCode == 401;

  @override
  String toString() => 'RunStartException($statusCode): $message';
}

/// The stream broke after it started; the text received so far is valid.
class RunInterruptedException implements Exception {
  const RunInterruptedException(this.cause);
  final Object cause;

  @override
  String toString() => 'RunInterruptedException: $cause';
}

class ServeClient {
  ServeClient({
    required Uri serveUrl,
    required String workflowName,
    required this._accessTokenProvider,
    http.Client? httpClient,
    RetryPolicy? retryPolicy,
    DelayFunction? delay,
    this.connectTimeout = const Duration(seconds: 15),
    this.idleTimeout = const Duration(seconds: 90),
  }) : _runsUrl = serveUrl.resolve(
         'v1/workflows/${Uri.encodeComponent(workflowName)}/runs',
       ),
       _httpClient = httpClient ?? http.Client(),
       _retryPolicy = retryPolicy ?? RetryPolicy(),
       _delay = delay ?? Future<void>.delayed;

  final Uri _runsUrl;
  final AccessTokenProvider _accessTokenProvider;
  final http.Client _httpClient;
  final RetryPolicy _retryPolicy;
  final DelayFunction _delay;

  /// Time allowed until the response headers arrive.
  final Duration connectTimeout;

  /// Longest silence tolerated mid-stream before it counts as dropped.
  final Duration idleTimeout;

  Uri get runsUrl => _runsUrl;

  /// Starts a run and yields its updates until the terminal [RunFinished].
  ///
  /// @throws RunStartException - The run could not be started.
  /// @throws RunInterruptedException - The stream broke after it started.
  Stream<RunUpdate> streamRun(RunRequest request) async* {
    final body = encodeRunBody(request);
    var attempt = 1;
    var tokenRefreshed = false;
    while (true) {
      final accessToken = await _accessTokenProvider(
        forceRefresh: tokenRefreshed,
      );
      StartFailure failure;
      try {
        final response = await _send(body, accessToken);
        if (response.statusCode == 200) {
          yield* _readUpdates(response);
          return;
        }
        failure = await _toHttpFailure(response);
      } on RunInterruptedException {
        rethrow;
      } on Exception catch (error) {
        failure = NetworkFailure(error);
      }
      final decision = _retryPolicy.decide(
        failure,
        attempt: attempt,
        tokenAlreadyRefreshed: tokenRefreshed,
      );
      switch (decision) {
        case GiveUp():
          throw _toStartException(failure);
        case RefreshTokenAndRetry():
          tokenRefreshed = true;
        case RetryAfterDelay(:final delay):
          await _delay(delay);
          attempt++;
      }
    }
  }

  Future<http.StreamedResponse> _send(List<int> body, String accessToken) {
    final httpRequest = http.Request('POST', _runsUrl)
      ..headers['content-type'] = 'application/json'
      ..headers['accept'] = 'text/event-stream'
      ..headers['x-user-authorization'] = 'Bearer $accessToken'
      ..bodyBytes = body;
    return _httpClient.send(httpRequest).timeout(connectTimeout);
  }

  Stream<RunUpdate> _readUpdates(http.StreamedResponse response) async* {
    final events = parseSseBytes(response.stream.timeout(idleTimeout));
    try {
      await for (final event in events) {
        final update = toRunUpdate(event);
        if (update == null) continue;
        yield update;
        if (update is RunFinished) return;
      }
    } on Exception catch (error) {
      throw RunInterruptedException(error);
    }
    throw const RunInterruptedException('stream closed before the run ended');
  }
}

Future<HttpFailure> _toHttpFailure(http.StreamedResponse response) async {
  final responseText = await response.stream.bytesToString().catchError(
    (Object _) => '',
  );
  return HttpFailure(
    statusCode: response.statusCode,
    message: _errorMessageOf(responseText, response.statusCode),
    retryAfter: parseRetryAfter(response.headers['retry-after']),
  );
}

/// The `error` field of serve's JSON errors (401, 429), else the plain-text
/// body (400, 413, 415), else the status code.
String _errorMessageOf(String responseText, int statusCode) {
  try {
    final decodedBody = jsonDecode(responseText);
    final errorValue = decodedBody is Map ? decodedBody['error'] : null;
    if (errorValue is String) return errorValue;
  } on FormatException {
    // Not JSON: fall through to the plain-text body.
  }
  final plainText = responseText.trim();
  if (plainText.isEmpty) return 'HTTP $statusCode';
  return plainText.length <= 200 ? plainText : plainText.substring(0, 200);
}

RunStartException _toStartException(StartFailure failure) => switch (failure) {
  NetworkFailure(:final cause) => RunStartException(
    'Cannot reach the chat server ($cause).',
  ),
  HttpFailure(statusCode: 401) => const RunStartException(
    'Your session has expired. Please sign in again.',
    statusCode: 401,
  ),
  HttpFailure(statusCode: 429, :final retryAfter) => RunStartException(
    retryAfter == null
        ? 'The chat server is busy. Try again shortly.'
        : 'Too many messages. Try again in ${retryAfter.inSeconds} s.',
    statusCode: 429,
  ),
  HttpFailure(:final statusCode, :final message) => RunStartException(
    message,
    statusCode: statusCode,
  ),
};
