import 'package:flutter/material.dart';

import '../chat/chat_controller.dart';

/// The chat screen: history, the streaming reply and the composer.
class ChatPage extends StatefulWidget {
  const ChatPage({
    super.key,
    required this.controller,
    required this.onSignOut,
  });
  final ChatController controller;
  final VoidCallback onSignOut;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final _composerController = TextEditingController();

  @override
  void initState() {
    super.initState();
    widget.controller.loadLatestSession();
  }

  @override
  void dispose() {
    _composerController.dispose();
    super.dispose();
  }

  void _send() {
    final text = _composerController.text;
    if (text.trim().isEmpty || widget.controller.isSending) return;
    _composerController.clear();
    widget.controller.sendMessage(text);
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Chatbot'),
        actions: [
          IconButton(
            tooltip: 'New chat',
            icon: const Icon(Icons.add_comment_outlined),
            onPressed: controller.startNewChat,
          ),
          IconButton(
            tooltip: 'Sign out',
            icon: const Icon(Icons.logout),
            onPressed: widget.onSignOut,
          ),
        ],
      ),
      body: SafeArea(
        child: ListenableBuilder(
          listenable: controller,
          builder: (context, _) => Column(
            children: [
              if (controller.noticeText != null)
                _NoticeBanner(text: controller.noticeText!),
              if (controller.needsSignIn)
                _NoticeBanner(
                  text: 'Session expired.',
                  actionLabel: 'Sign in again',
                  onAction: widget.onSignOut,
                ),
              Expanded(child: _buildMessageList(controller)),
              if (controller.isToolRunning) const _ToolActivityIndicator(),
              _Composer(
                textController: _composerController,
                isSending: controller.isSending,
                onSend: _send,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildMessageList(ChatController controller) {
    if (controller.isLoading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (controller.messages.isEmpty) {
      return const Center(child: Text('Ask me about your diary or dates.'));
    }
    final messages = controller.messages;
    return ListView.builder(
      reverse: true,
      padding: const EdgeInsets.all(12),
      itemCount: messages.length,
      itemBuilder: (context, reversedIndex) {
        final index = messages.length - 1 - reversedIndex;
        final isLast = index == messages.length - 1;
        return _MessageBubble(
          message: messages[index],
          onRetry: isLast && controller.canRetry
              ? controller.retryLastReply
              : null,
        );
      },
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message, this.onRetry});
  final ChatMessage message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isStreaming = message.status == MessageStatus.streaming;
    final bubbleText = message.text.isEmpty && isStreaming ? '…' : message.text;
    return Align(
      alignment: message.isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 4),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: message.isUser
                ? colors.primaryContainer
                : colors.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(16),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (bubbleText.isNotEmpty) SelectableText(bubbleText),
              if (message.errorText != null)
                _ReplyProblem(text: message.errorText!, onRetry: onRetry),
            ],
          ),
        ),
      ),
    );
  }
}

class _ReplyProblem extends StatelessWidget {
  const _ReplyProblem({required this.text, this.onRetry});
  final String text;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final errorColor = Theme.of(context).colorScheme.error;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 8,
        children: [
          Text(text, style: TextStyle(color: errorColor, fontSize: 13)),
          if (onRetry != null)
            TextButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh, size: 18),
              label: const Text('Retry'),
            ),
        ],
      ),
    );
  }
}

class _ToolActivityIndicator extends StatelessWidget {
  const _ToolActivityIndicator();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: Row(
        children: [
          SizedBox.square(
            dimension: 14,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          SizedBox(width: 8),
          Text('Looking up your data…'),
        ],
      ),
    );
  }
}

class _NoticeBanner extends StatelessWidget {
  const _NoticeBanner({required this.text, this.actionLabel, this.onAction});
  final String text;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return MaterialBanner(
      content: Text(text),
      actions: [
        if (actionLabel != null)
          TextButton(onPressed: onAction, child: Text(actionLabel!))
        else
          const SizedBox.shrink(),
      ],
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.textController,
    required this.isSending,
    required this.onSend,
  });
  final TextEditingController textController;
  final bool isSending;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 8, 8),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: textController,
              minLines: 1,
              maxLines: 5,
              maxLength: 4000,
              textInputAction: TextInputAction.send,
              decoration: const InputDecoration(
                hintText: 'Message',
                counterText: '',
              ),
              onSubmitted: (_) => onSend(),
            ),
          ),
          IconButton(
            tooltip: 'Send',
            icon: const Icon(Icons.send),
            onPressed: isSending ? null : onSend,
          ),
        ],
      ),
    );
  }
}
