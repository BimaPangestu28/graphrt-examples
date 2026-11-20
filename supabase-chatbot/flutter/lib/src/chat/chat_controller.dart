/// State of one chat screen: messages, streaming reply, tool activity.
///
/// Flow of a turn: save the user message, stream the run from serve
/// (rendering `response` text as it arrives), save the assistant reply when
/// the run succeeds. A reply cut mid-stream keeps its partial text and is
/// marked [MessageStatus.interrupted] so the UI can offer "Retry".
library;

import 'package:flutter/foundation.dart';

import '../serve/run_request.dart';
import '../serve/run_update.dart';
import '../serve/serve_client.dart';
import 'chat_history_store.dart';

enum MessageStatus { complete, streaming, interrupted, failed }

class ChatMessage {
  ChatMessage({
    required this.role,
    required this.text,
    this.status = MessageStatus.complete,
    this.errorText,
  });

  /// `user` or `assistant`.
  final String role;
  String text;
  MessageStatus status;

  /// Why the reply failed or stopped, shown under it.
  String? errorText;

  bool get isUser => role == 'user';
}

/// Streams runs; the [ServeClient] in the app, a fake in tests.
typedef RunStreamer = Stream<RunUpdate> Function(RunRequest request);

class ChatController extends ChangeNotifier {
  ChatController({
    required this._runStreamer,
    required this._historyStore,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  final RunStreamer _runStreamer;
  final ChatHistoryStore _historyStore;
  final DateTime Function() _clock;
  final Set<String> _runningToolCalls = {};
  bool _isDisposed = false;

  final List<ChatMessage> messages = [];
  String? sessionId;
  bool isLoading = false;
  bool isSending = false;

  /// A problem not tied to one message (history could not load or save).
  String? noticeText;

  /// Set when the server refused the token even after a refresh.
  bool needsSignIn = false;

  /// Whether the agent is calling a tool right now.
  bool get isToolRunning => _runningToolCalls.isNotEmpty;

  /// The last reply was cut or failed and can be generated again.
  bool get canRetry =>
      !isSending &&
      messages.isNotEmpty &&
      !messages.last.isUser &&
      messages.last.status != MessageStatus.complete;

  /// Loads the newest chat session and its messages.
  Future<void> loadLatestSession() async {
    isLoading = true;
    notifyListeners();
    try {
      sessionId = await _historyStore.latestSessionId();
      final storedMessages = sessionId == null
          ? const <StoredMessage>[]
          : await _historyStore.listMessages(sessionId!);
      messages
        ..clear()
        ..addAll([
          for (final stored in storedMessages)
            ChatMessage(role: stored.role, text: stored.content),
        ]);
    } catch (error) {
      noticeText = 'Could not load chat history: $error';
    } finally {
      isLoading = false;
      notifyListeners();
    }
  }

  /// Clears the screen; the next message creates a new session.
  void startNewChat() {
    if (isSending) return;
    sessionId = null;
    messages.clear();
    noticeText = null;
    notifyListeners();
  }

  /// Sends [rawText] as a new user message and streams the reply.
  Future<void> sendMessage(String rawText) async {
    final text = rawText.trim();
    if (isSending || text.isEmpty) return;
    if (text.length > RunLimits.maxMessageChars) {
      noticeText =
          'Messages are limited to ${RunLimits.maxMessageChars} '
          'characters.';
      notifyListeners();
      return;
    }
    noticeText = null;
    messages.add(ChatMessage(role: 'user', text: text));
    isSending = true;
    notifyListeners();
    await _saveMessage(StoredMessage(role: 'user', content: text));
    await _streamReply(text);
  }

  /// Generates the last reply again (after a drop or a failure).
  Future<void> retryLastReply() async {
    if (!canRetry) return;
    messages.removeLast();
    final lastUserMessage = messages.lastWhere((message) => message.isUser);
    isSending = true;
    notifyListeners();
    await _streamReply(lastUserMessage.text);
  }

  /// The complete turns before the current user message, oldest first.
  List<ChatTurn> _historyBeforeCurrentMessage() {
    final earlierMessages = messages.sublist(0, messages.length - 1);
    final completedTurns = [
      for (final message in earlierMessages)
        if (message.status == MessageStatus.complete)
          ChatTurn(role: message.role, content: message.text),
    ];
    final firstKept = completedTurns.length - RunLimits.maxHistoryMessages;
    return firstKept > 0 ? completedTurns.sublist(firstKept) : completedTurns;
  }

  Future<void> _streamReply(String userText) async {
    final request = RunRequest(
      message: userText,
      history: _historyBeforeCurrentMessage(),
      today: _clock(),
      sessionId: sessionId,
    );
    final reply = ChatMessage(
      role: 'assistant',
      text: '',
      status: MessageStatus.streaming,
    );
    messages.add(reply);
    notifyListeners();
    try {
      await for (final update in _runStreamer(request)) {
        if (_isDisposed) return;
        _applyUpdate(reply, update);
      }
    } catch (error) {
      _markReplyBroken(reply, error);
    }
    if (_isDisposed) return;
    _runningToolCalls.clear();
    if (reply.status == MessageStatus.streaming) {
      _markReplyBroken(reply, const RunInterruptedException('no end event'));
    }
    isSending = false;
    notifyListeners();
    if (reply.status == MessageStatus.complete) {
      await _saveMessage(StoredMessage(role: 'assistant', content: reply.text));
    }
  }

  void _applyUpdate(ChatMessage reply, RunUpdate update) {
    switch (update) {
      case AnswerDelta(:final text):
        reply.text += text;
      case ToolActivity(:final callId, isRunning: true):
        _runningToolCalls.add(callId);
      case ToolActivity(:final callId):
        _runningToolCalls.remove(callId);
      case RunFinished(outcome: RunOutcome.succeeded):
        reply.status = MessageStatus.complete;
      case RunFinished(:final errorMessage):
        reply
          ..status = MessageStatus.failed
          ..errorText = errorMessage ?? 'The assistant stopped.';
    }
    notifyListeners();
  }

  void _markReplyBroken(ChatMessage reply, Object error) {
    if (error is RunInterruptedException) {
      reply
        ..status = MessageStatus.interrupted
        ..errorText = 'Connection lost.';
      return;
    }
    if (error is RunStartException && error.needsSignIn) needsSignIn = true;
    reply
      ..status = MessageStatus.failed
      ..errorText = error is RunStartException ? error.message : '$error';
  }

  Future<void> _saveMessage(StoredMessage message) async {
    try {
      sessionId ??= await _historyStore.startSession(_titleFor(message));
      await _historyStore.addMessage(sessionId!, message);
    } catch (error) {
      noticeText = 'Could not save chat history: $error';
      notifyListeners();
    }
  }

  String _titleFor(StoredMessage message) => message.content.length <= 60
      ? message.content
      : '${message.content.substring(0, 57)}...';

  @override
  void notifyListeners() {
    if (!_isDisposed) super.notifyListeners();
  }

  @override
  void dispose() {
    // Leaving the screen ends the `await for`, which cancels the stream.
    _isDisposed = true;
    super.dispose();
  }
}
