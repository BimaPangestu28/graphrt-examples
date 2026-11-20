/// Chat history in Supabase (`chat_sessions`, `chat_messages`).
///
/// Every call runs as the signed-in user (anon key + user JWT), so row level
/// security limits it to that user's rows. Writes go through the
/// `start_chat_session` and `add_chat_message` RPCs from the backend migration.
library;

import 'package:supabase_flutter/supabase_flutter.dart';

/// A saved chat message.
class StoredMessage {
  const StoredMessage({required this.role, required this.content});
  final String role;
  final String content;
}

/// Persistence the chat needs; an interface so tests can use a fake.
abstract interface class ChatHistoryStore {
  /// The id of the user's newest chat session, or null when there is none.
  Future<String?> latestSessionId();

  /// Creates a session and returns its id.
  Future<String> startSession(String title);

  /// The session's latest 50 messages, oldest first.
  Future<List<StoredMessage>> listMessages(String sessionId);

  Future<void> addMessage(String sessionId, StoredMessage message);
}

class SupabaseChatHistoryStore implements ChatHistoryStore {
  const SupabaseChatHistoryStore(this._supabase);
  final SupabaseClient _supabase;

  @override
  Future<String?> latestSessionId() async {
    final sessionRow = await _supabase
        .from('chat_sessions')
        .select('id')
        .order('created_at', ascending: false)
        .limit(1)
        .maybeSingle();
    return sessionRow?['id'] as String?;
  }

  @override
  Future<String> startSession(String title) async {
    final sessionRow = await _supabase.rpc(
      'start_chat_session',
      params: {'title': title},
    );
    return (sessionRow as Map<String, dynamic>)['id'] as String;
  }

  @override
  Future<List<StoredMessage>> listMessages(String sessionId) async {
    final messageRows = await _supabase.rpc(
      'list_chat_messages',
      params: {'session_id': sessionId},
    );
    return [
      for (final row in (messageRows as List).cast<Map<String, dynamic>>())
        StoredMessage(
          role: row['role'] as String,
          content: row['content'] as String,
        ),
    ];
  }

  @override
  Future<void> addMessage(String sessionId, StoredMessage message) async {
    await _supabase.rpc(
      'add_chat_message',
      params: {
        'session_id': sessionId,
        'role': message.role,
        'content': message.content,
      },
    );
  }
}
