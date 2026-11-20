/// Incremental parser for `text/event-stream` (Server-Sent Events).
///
/// Follows the WHATWG event-stream rules that matter for `graphrt serve`:
/// lines end with `\n`, `\r\n` or `\r` (also when split across chunks), a
/// blank line dispatches the event, `data:` lines are joined with `\n`, one
/// leading space after the colon is dropped, `:` lines are comments
/// (keep-alives), and an event without `data:` is not dispatched.
library;

import 'dart:async';
import 'dart:convert';

/// One dispatched SSE event.
class SseEvent {
  const SseEvent({required this.type, required this.data, this.id});

  /// The `event:` field, `message` when absent.
  final String type;

  /// All `data:` lines of the event, joined with `\n`.
  final String data;

  /// The `id:` field, if any.
  final String? id;

  /// Decodes [data] as a JSON object, or returns null when it is not one.
  Map<String, dynamic>? get jsonData {
    try {
      final decodedValue = jsonDecode(data);
      return decodedValue is Map<String, dynamic> ? decodedValue : null;
    } on FormatException {
      return null;
    }
  }

  @override
  String toString() => 'SseEvent($type, $data)';
}

/// Feeds decoded text chunks in and returns the events they complete.
///
/// @example
/// final parser = SseParser();
/// parser.addChunk('event: response\ndata: {"text":"Hi"}\n'); // []
/// parser.addChunk('\n'); // [SseEvent(response, {"text":"Hi"})]
class SseParser {
  final StringBuffer _pendingLine = StringBuffer();
  final List<String> _dataLines = [];
  String? _eventType;
  String? _eventId;
  bool _skipNextLineFeed = false;

  /// Parses [chunk] and returns every event completed by it (maybe none).
  List<SseEvent> addChunk(String chunk) {
    final completedEvents = <SseEvent>[];
    for (var index = 0; index < chunk.length; index++) {
      final character = chunk[index];
      if (_skipNextLineFeed) {
        _skipNextLineFeed = false;
        if (character == '\n') continue;
      }
      if (character == '\r' || character == '\n') {
        _skipNextLineFeed = character == '\r';
        final event = _processLine(_pendingLine.toString());
        _pendingLine.clear();
        if (event != null) completedEvents.add(event);
      } else {
        _pendingLine.write(character);
      }
    }
    return completedEvents;
  }

  /// Whether a partly received event is buffered (the stream was cut mid-event).
  bool get hasPartialEvent =>
      _pendingLine.isNotEmpty || _dataLines.isNotEmpty || _eventType != null;

  SseEvent? _processLine(String line) {
    if (line.isEmpty) return _dispatch();
    if (line.startsWith(':')) return null;
    final colonIndex = line.indexOf(':');
    final fieldName = colonIndex < 0 ? line : line.substring(0, colonIndex);
    var fieldValue = colonIndex < 0 ? '' : line.substring(colonIndex + 1);
    if (fieldValue.startsWith(' ')) fieldValue = fieldValue.substring(1);
    switch (fieldName) {
      case 'event':
        _eventType = fieldValue;
      case 'data':
        _dataLines.add(fieldValue);
      case 'id':
        _eventId = fieldValue;
    }
    return null;
  }

  SseEvent? _dispatch() {
    final hasData = _dataLines.isNotEmpty;
    final event = hasData
        ? SseEvent(
            type: (_eventType == null || _eventType!.isEmpty)
                ? 'message'
                : _eventType!,
            data: _dataLines.join('\n'),
            id: _eventId,
          )
        : null;
    _dataLines.clear();
    _eventType = null;
    return event;
  }
}

/// Decodes a byte stream as UTF-8 and parses it into SSE events.
///
/// A trailing event without its closing blank line is dropped, as the spec
/// requires: a cut stream never yields a half event.
Stream<SseEvent> parseSseBytes(Stream<List<int>> byteStream) async* {
  final parser = SseParser();
  await for (final textChunk in byteStream.transform(utf8.decoder)) {
    for (final event in parser.addChunk(textChunk)) {
      yield event;
    }
  }
}
