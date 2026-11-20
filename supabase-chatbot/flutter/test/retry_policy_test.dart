import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:supabase_chatbot/src/serve/retry_policy.dart';

/// Always returns the largest value, so jittered delays equal their cap.
class MaxRandom implements Random {
  @override
  int nextInt(int max) => max - 1;
  @override
  bool nextBool() => true;
  @override
  double nextDouble() => 1;
}

void main() {
  final policy = RetryPolicy(random: MaxRandom());
  const network = NetworkFailure('connection refused');

  HttpFailure http(int code, {Duration? retryAfter}) =>
      HttpFailure(statusCode: code, message: 'x', retryAfter: retryAfter);

  RetryDecision decide(
    StartFailure failure, {
    int attempt = 1,
    bool refreshed = false,
  }) => policy.decide(
    failure,
    attempt: attempt,
    tokenAlreadyRefreshed: refreshed,
  );

  test('backoff doubles from 500 ms and is capped at 8 s', () {
    expect(
      [
        for (var attempt = 1; attempt <= 7; attempt++)
          policy.backoffFor(attempt).inMilliseconds,
      ],
      [500, 1000, 2000, 4000, 8000, 8000, 8000],
    );
  });

  test('backoff jitter stays within [delay/2, delay]', () {
    final jittered = RetryPolicy(random: Random(7));
    for (var attempt = 1; attempt <= 6; attempt++) {
      final cap = min(500 * pow(2, attempt - 1), 8000);
      final delayMs = jittered.backoffFor(attempt).inMilliseconds;
      expect(delayMs, inInclusiveRange(cap / 2, cap));
    }
  });

  test('401 refreshes the token once, then gives up', () {
    expect(decide(http(401)), isA<RefreshTokenAndRetry>());
    expect(decide(http(401), refreshed: true), isA<GiveUp>());
  });

  test('401 refresh is allowed even on the last attempt', () {
    expect(decide(http(401), attempt: 4), isA<RefreshTokenAndRetry>());
  });

  test('network errors back off until the attempts run out', () {
    expect(
      decide(network),
      isA<RetryAfterDelay>().having(
        (d) => d.delay,
        'delay',
        const Duration(milliseconds: 500),
      ),
    );
    expect(
      decide(network, attempt: 3),
      isA<RetryAfterDelay>().having(
        (d) => d.delay,
        'delay',
        const Duration(seconds: 2),
      ),
    );
    expect(decide(network, attempt: 4), isA<GiveUp>());
  });

  test('429 with Retry-After waits exactly that long', () {
    final decision = decide(http(429, retryAfter: const Duration(seconds: 3)));
    expect(
      decision,
      isA<RetryAfterDelay>().having(
        (d) => d.delay,
        'delay',
        const Duration(seconds: 3),
      ),
    );
  });

  test('429 with a Retry-After over the limit gives up', () {
    expect(
      decide(http(429, retryAfter: const Duration(minutes: 5))),
      isA<GiveUp>(),
    );
  });

  test('429 without Retry-After (server busy) backs off', () {
    expect(
      decide(http(429), attempt: 2),
      isA<RetryAfterDelay>().having(
        (d) => d.delay,
        'delay',
        const Duration(seconds: 1),
      ),
    );
  });

  test('transient 5xx back off, honoring Retry-After', () {
    for (final code in [500, 502, 503, 504, 408]) {
      expect(decide(http(code)), isA<RetryAfterDelay>(), reason: '$code');
    }
    expect(
      decide(http(503, retryAfter: const Duration(seconds: 2))),
      isA<RetryAfterDelay>().having(
        (d) => d.delay,
        'delay',
        const Duration(seconds: 2),
      ),
    );
  });

  test('client errors are not retried', () {
    for (final code in [400, 403, 404, 413, 415]) {
      expect(decide(http(code)), isA<GiveUp>(), reason: '$code');
    }
  });

  test('parseRetryAfter reads seconds and ignores dates and junk', () {
    expect(parseRetryAfter(' 12 '), const Duration(seconds: 12));
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT'), isNull);
    expect(parseRetryAfter('-1'), isNull);
    expect(parseRetryAfter(null), isNull);
  });
}
