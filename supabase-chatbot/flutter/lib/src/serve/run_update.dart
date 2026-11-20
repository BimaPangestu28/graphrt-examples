/// What the chat UI needs from a `graphrt serve` run stream.
///
/// The raw stream carries many event types (`node_started`, `node_chunk`,
/// ...); the app only renders `response` text, a tool-activity indicator from
/// `node_progress`, and the terminal event. Everything else is ignored.
library;

import 'sse_parser.dart';

/// One update of a streamed run, derived from an [SseEvent].
sealed class RunUpdate {
  const RunUpdate();
}

/// More answer text (a `response` event); append it to the reply.
class AnswerDelta extends RunUpdate {
  const AnswerDelta(this.text);
  final String text;
}

/// The agent started (`tool_call`) or finished (`tool_result`) a tool call.
class ToolActivity extends RunUpdate {
  const ToolActivity({required this.callId, required this.isRunning});
  final String callId;
  final bool isRunning;
}

/// How a run ended on the server.
enum RunOutcome { succeeded, failed, aborted, paused }

/// The terminal event: the server closes the stream after it.
class RunFinished extends RunUpdate {
  const RunFinished(this.outcome, {this.errorMessage});
  final RunOutcome outcome;

  /// `data.error` of `run_failed`, if any.
  final String? errorMessage;
}

const Map<String, RunOutcome> _terminalEventTypes = {
  'run_succeeded': RunOutcome.succeeded,
  'run_failed': RunOutcome.failed,
  'run_aborted': RunOutcome.aborted,
  'run_paused': RunOutcome.paused,
};

/// Maps one SSE event to a [RunUpdate], or null when the UI ignores it.
RunUpdate? toRunUpdate(SseEvent event) {
  final terminalOutcome = _terminalEventTypes[event.type];
  if (terminalOutcome != null) {
    final errorValue = event.jsonData?['error'];
    return RunFinished(
      terminalOutcome,
      errorMessage: errorValue is String ? errorValue : null,
    );
  }
  if (event.type == 'response') {
    final text = event.jsonData?['text'];
    return text is String && text.isNotEmpty ? AnswerDelta(text) : null;
  }
  if (event.type == 'node_progress') return _toToolActivity(event);
  return null;
}

ToolActivity? _toToolActivity(SseEvent event) {
  final payload = event.jsonData;
  final progressName = payload?['name'];
  if (progressName != 'tool_call' && progressName != 'tool_result') {
    return null;
  }
  final progressData = payload?['data'];
  final callId = progressData is Map ? '${progressData['id'] ?? ''}' : '';
  return ToolActivity(callId: callId, isRunning: progressName == 'tool_call');
}
