/// The signed-in user's Supabase access token, for `X-User-Authorization`.
library;

import 'package:supabase_flutter/supabase_flutter.dart';

import '../serve/serve_client.dart';

/// Builds an [AccessTokenProvider] backed by [auth].
///
/// The token is refreshed when it has expired or when serve refused it
/// (`forceRefresh`). A failed refresh means the session is gone: it surfaces
/// as a 401 [RunStartException] so the UI asks the user to sign in again.
AccessTokenProvider supabaseAccessTokenProvider(GoTrueClient auth) {
  return ({bool forceRefresh = false}) async {
    final currentSession = auth.currentSession;
    if (currentSession == null) {
      throw const RunStartException('You are signed out.', statusCode: 401);
    }
    if (!forceRefresh && !currentSession.isExpired) {
      return currentSession.accessToken;
    }
    try {
      final refreshed = await auth.refreshSession();
      final refreshedSession = refreshed.session;
      if (refreshedSession == null) {
        throw const RunStartException('You are signed out.', statusCode: 401);
      }
      return refreshedSession.accessToken;
    } on AuthRetryableFetchException {
      // Offline: not a sign-out, report it as a connection problem.
      rethrow;
    } on AuthException catch (error) {
      throw RunStartException(
        'Your session has expired (${error.message}). Please sign in again.',
        statusCode: 401,
      );
    }
  };
}
