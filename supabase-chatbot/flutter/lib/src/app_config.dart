/// Build-time configuration, passed with `--dart-define` or
/// `--dart-define-from-file=config.json`.
///
/// Only public values belong here: the Supabase URL, its anon (publishable)
/// key and the serve URL. No LLM key, service role key or serve API key: the
/// app authenticates to serve with the user's own Supabase access token.
library;

import 'dart:convert';

class AppConfig {
  const AppConfig({
    required this.supabaseUrl,
    required this.supabaseAnonKey,
    required this.serveUrl,
    required this.workflowName,
  });

  /// Reads the compile-time environment.
  factory AppConfig.fromEnvironment() => const AppConfig(
    supabaseUrl: String.fromEnvironment('SUPABASE_URL'),
    supabaseAnonKey: String.fromEnvironment('SUPABASE_ANON_KEY'),
    serveUrl: String.fromEnvironment('SERVE_URL'),
    workflowName: String.fromEnvironment(
      'WORKFLOW_NAME',
      defaultValue: 'agent',
    ),
  );

  final String supabaseUrl;
  final String supabaseAnonKey;
  final String serveUrl;

  /// The served workflow: the file stem of `agent.yaml`.
  final String workflowName;

  /// [serveUrl] with a trailing slash, so relative paths keep any prefix.
  Uri get serveBaseUri =>
      Uri.parse(serveUrl.endsWith('/') ? serveUrl : '$serveUrl/');

  /// Human-readable problems; empty when the configuration is usable.
  List<String> validate() => [
    ..._checkHttpUrl('SUPABASE_URL', supabaseUrl),
    if (supabaseAnonKey.isEmpty) 'SUPABASE_ANON_KEY is not set.',
    if (_looksLikeServiceRoleKey(supabaseAnonKey))
      'SUPABASE_ANON_KEY looks like a secret/service role key; use the anon '
          '(publishable) key.',
    ..._checkHttpUrl('SERVE_URL', serveUrl),
    if (workflowName.isEmpty) 'WORKFLOW_NAME is empty.',
  ];
}

List<String> _checkHttpUrl(String name, String value) {
  if (value.isEmpty) return ['$name is not set.'];
  final parsedUri = Uri.tryParse(value);
  final isHttp =
      parsedUri != null &&
      (parsedUri.scheme == 'https' || parsedUri.scheme == 'http') &&
      parsedUri.host.isNotEmpty;
  return isHttp ? const [] : ['$name must be an http(s) URL, got "$value".'];
}

/// New-style secret keys start with `sb_secret_`; legacy keys are JWTs whose
/// payload names the role.
bool _looksLikeServiceRoleKey(String key) {
  if (key.startsWith('sb_secret_')) return true;
  final keyParts = key.split('.');
  if (keyParts.length != 3) return false;
  try {
    final payloadText = utf8.decode(
      base64Url.decode(base64Url.normalize(keyParts[1])),
    );
    return payloadText.contains('"service_role"');
  } on FormatException {
    return false;
  }
}
