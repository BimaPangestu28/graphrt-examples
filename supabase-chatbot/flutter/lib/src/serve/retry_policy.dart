/// When and how long to wait before re-sending a run request.
///
/// Only failures *before* the stream starts are retried automatically: a run
/// that already streamed may have called tools (for example saved a chat
/// message), so re-running it is left to the user ("Retry" button).
library;

import 'dart:math';

/// Why a request attempt failed before any event arrived.
sealed class StartFailure {
  const StartFailure();
}

/// No connection, DNS failure, timeout before the response headers.
class NetworkFailure extends StartFailure {
  const NetworkFailure(this.cause);
  final Object cause;
}

/// A non-2xx status with the server's `{"error": "..."}` message.
class HttpFailure extends StartFailure {
  const HttpFailure({
    required this.statusCode,
    required this.message,
    this.retryAfter,
  });
  final int statusCode;
  final String message;

  /// The `Retry-After` header (seconds form) of a 429/503.
  final Duration? retryAfter;
}

/// What to do after a failed attempt.
sealed class RetryDecision {
  const RetryDecision();
}

/// Stop and report the failure.
class GiveUp extends RetryDecision {
  const GiveUp();
}

/// Refresh the Supabase session, then retry at once (only once per send).
class RefreshTokenAndRetry extends RetryDecision {
  const RefreshTokenAndRetry();
}

/// Wait [delay], then retry.
class RetryAfterDelay extends RetryDecision {
  const RetryAfterDelay(this.delay);
  final Duration delay;
}

const Set<int> _transientStatusCodes = {408, 500, 502, 503, 504};

/// Exponential backoff with full jitter, capped by attempts and delay.
class RetryPolicy {
  RetryPolicy({
    this.maxAttempts = 4,
    this.baseDelay = const Duration(milliseconds: 500),
    this.maxDelay = const Duration(seconds: 8),
    this.maxRetryAfter = const Duration(seconds: 60),
    Random? random,
  }) : _random = random ?? Random();

  /// Total attempts per send, including the first (token refresh not counted).
  final int maxAttempts;
  final Duration baseDelay;
  final Duration maxDelay;

  /// A longer `Retry-After` is not waited for: the user is told instead.
  final Duration maxRetryAfter;
  final Random _random;

  /// Backoff before retry number [attempt] (1 = first retry): a random value
  /// in `[delay/2, delay]` where `delay = min(maxDelay, baseDelay * 2^(attempt-1))`.
  Duration backoffFor(int attempt) {
    final exponent = min(max(attempt - 1, 0), 20);
    final cappedMicros = min(
      baseDelay.inMicroseconds * pow(2, exponent).toInt(),
      maxDelay.inMicroseconds,
    );
    final halfMicros = cappedMicros ~/ 2;
    return Duration(
      microseconds: halfMicros + _random.nextInt(max(halfMicros, 1) + 1),
    );
  }

  /// Decides what to do after [failure] on attempt number [attempt] (1-based).
  ///
  /// @param failure - Why the attempt failed (StartFailure)
  /// @param attempt - The attempt that failed, starting at 1 (int)
  /// @param tokenAlreadyRefreshed - Whether this send already refreshed once (bool)
  RetryDecision decide(
    StartFailure failure, {
    required int attempt,
    required bool tokenAlreadyRefreshed,
  }) {
    if (failure is HttpFailure && failure.statusCode == 401) {
      return tokenAlreadyRefreshed
          ? const GiveUp()
          : const RefreshTokenAndRetry();
    }
    if (attempt >= maxAttempts) return const GiveUp();
    return switch (failure) {
      NetworkFailure() => RetryAfterDelay(backoffFor(attempt)),
      HttpFailure(statusCode: 429, retryAfter: final Duration wait) =>
        wait <= maxRetryAfter ? RetryAfterDelay(wait) : const GiveUp(),
      HttpFailure(statusCode: 429) => RetryAfterDelay(backoffFor(attempt)),
      HttpFailure(:final statusCode)
          when _transientStatusCodes.contains(statusCode) =>
        RetryAfterDelay(failure.retryAfter ?? backoffFor(attempt)),
      HttpFailure() => const GiveUp(),
    };
  }
}

/// Parses a `Retry-After` header in its seconds form; dates are ignored.
Duration? parseRetryAfter(String? headerValue) {
  final seconds = int.tryParse(headerValue?.trim() ?? '');
  return seconds == null || seconds < 0 ? null : Duration(seconds: seconds);
}
