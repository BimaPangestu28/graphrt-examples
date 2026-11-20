/// The JSON body of `POST /v1/workflows/{name}/runs` for the chatbot agent.
library;

import 'dart:convert';

/// One earlier message sent as `sys.history`.
class ChatTurn {
  const ChatTurn({required this.role, required this.content});

  /// `user` or `assistant`.
  final String role;
  final String content;

  Map<String, String> toJson() => {'role': role, 'content': content};
}

/// Limits enforced by the backend (`agent.yaml` and `--max-body-bytes`).
abstract final class RunLimits {
  /// `start.message` has `max_length: 4000`.
  static const int maxMessageChars = 4000;

  /// The agent keeps the last 8 exchanges (`memory.window.size: 8`).
  static const int maxHistoryMessages = 16;

  /// `--max-body-bytes 65536`, minus headroom for the JSON envelope.
  static const int maxBodyBytes = 60 * 1024;
}

/// Inputs of one chat turn.
class RunRequest {
  const RunRequest({
    required this.message,
    required this.history,
    required this.today,
    this.sessionId,
  });

  /// The current user message (not repeated in [history]).
  final String message;

  /// Earlier turns, oldest first.
  final List<ChatTurn> history;
  final DateTime today;
  final String? sessionId;
}

/// Encodes [request] as the run body, dropping the oldest history entries
/// until it fits [RunLimits.maxBodyBytes].
///
/// @throws ArgumentError - The message is empty or over 4000 characters.
List<int> encodeRunBody(RunRequest request) {
  final message = request.message.trim();
  if (message.isEmpty || message.length > RunLimits.maxMessageChars) {
    throw ArgumentError.value(
      message.length,
      'message',
      'must be 1..${RunLimits.maxMessageChars} characters',
    );
  }
  var history = request.history.length > RunLimits.maxHistoryMessages
      ? request.history.sublist(
          request.history.length - RunLimits.maxHistoryMessages,
        )
      : request.history;
  while (true) {
    final encodedBody = utf8.encode(
      jsonEncode(_bodyJson(request, message, history)),
    );
    if (encodedBody.length <= RunLimits.maxBodyBytes || history.isEmpty) {
      return encodedBody;
    }
    history = history.sublist(1);
  }
}

Map<String, Object?> _bodyJson(
  RunRequest request,
  String message,
  List<ChatTurn> history,
) => {
  'stream': true,
  'inputs': {
    'message': message,
    if (request.sessionId != null) 'session_id': request.sessionId,
  },
  'sys': {
    'history': [for (final turn in history) turn.toJson()],
    'today': formatIsoDate(request.today),
  },
};

/// `YYYY-MM-DD` of [date] in its own time zone.
String formatIsoDate(DateTime date) =>
    '${date.year.toString().padLeft(4, '0')}-'
    '${date.month.toString().padLeft(2, '0')}-'
    '${date.day.toString().padLeft(2, '0')}';
