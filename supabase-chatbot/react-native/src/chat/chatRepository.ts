/**
 * Chat history in Supabase: `chat_sessions` / `chat_messages`, reached through
 * the RPCs from the backend migration (start_chat_session, add_chat_message,
 * list_chat_messages). Row level security limits every call to the signed-in
 * user's own rows; the app only holds the anon key.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChatRole } from './history.ts';

export interface StoredChatMessage {
  id: number;
  role: ChatRole;
  content: string;
}

export interface ChatSession {
  id: string;
  title: string;
}

/** Sessions are titled after the first message, cut to this length. */
const SESSION_TITLE_CHARS = 60;

export function createChatRepository(client: SupabaseClient) {
  return {
    /** The most recent session of the user, or null when there is none. */
    async findLatestSession(): Promise<ChatSession | null> {
      const { data, error } = await client
        .from('chat_sessions')
        .select('id, title')
        .order('created_at', { ascending: false })
        .limit(1);
      throwIfFailed(error, 'load your chats');
      return (data?.[0] as ChatSession | undefined) ?? null;
    },

    async startSession(firstMessage: string): Promise<ChatSession> {
      const title = firstMessage.trim().slice(0, SESSION_TITLE_CHARS);
      const { data, error } = await client.rpc('start_chat_session', { title });
      throwIfFailed(error, 'start a chat');
      return data as ChatSession;
    },

    /** The last 50 messages of a session, oldest first. */
    async listMessages(sessionId: string): Promise<StoredChatMessage[]> {
      const { data, error } = await client.rpc('list_chat_messages', { session_id: sessionId });
      throwIfFailed(error, 'load the conversation');
      return (data as StoredChatMessage[] | null) ?? [];
    },

    async addMessage(sessionId: string, role: ChatRole, content: string): Promise<StoredChatMessage> {
      const { data, error } = await client.rpc('add_chat_message', { session_id: sessionId, role, content });
      throwIfFailed(error, 'save the message');
      return data as StoredChatMessage;
    },
  };
}

export type ChatRepository = ReturnType<typeof createChatRepository>;

function throwIfFailed(error: { message: string } | null, action: string): void {
  if (error) {
    throw new Error(`Could not ${action}: ${error.message}`);
  }
}
