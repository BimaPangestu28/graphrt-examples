/**
 * The chat: message list, tool-activity indicator, status line and composer.
 * All state lives in useChat; this file only renders it.
 */
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from '../config.ts';
import { MAX_MESSAGE_CHARS } from '../chat/history.ts';
import { useChat, type ChatBubble } from '../chat/useChat.ts';
import { MessageBubble } from './MessageBubble.tsx';
import { colors } from './theme.ts';

interface ChatScreenProps {
  config: AppConfig;
  client: SupabaseClient;
}

export function ChatScreen({ config, client }: ChatScreenProps) {
  const signOut = useCallback(() => void client.auth.signOut(), [client]);
  const chat = useChat(config, client, signOut);
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList<ChatBubble>>(null);

  const submitDraft = async (): Promise<void> => {
    if (await chat.sendMessage(draft)) {
      setDraft('');
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Pressable onPress={chat.startNewChat} disabled={chat.isSending}>
          <Text style={[styles.headerAction, chat.isSending && styles.disabled]}>New chat</Text>
        </Pressable>
        <Pressable onPress={signOut}>
          <Text style={styles.headerAction}>Sign out</Text>
        </Pressable>
      </View>
      {chat.isLoading ? (
        <ActivityIndicator style={styles.loading} color={colors.accent} />
      ) : (
        <FlatList
          ref={listRef}
          data={chat.bubbles}
          keyExtractor={(bubble) => bubble.key}
          renderItem={({ item }) => <MessageBubble bubble={item} onRetry={chat.retryAnswer} />}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={<Text style={styles.emptyText}>Ask about your diary, dates or profile.</Text>}
        />
      )}
      {chat.runningToolNames.length > 0 ? (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={colors.mutedText} />
          <Text style={styles.statusText}>Looking up your data…</Text>
        </View>
      ) : null}
      {chat.statusNotice ? <Text style={[styles.statusText, styles.statusRow]}>{chat.statusNotice}</Text> : null}
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          placeholder="Message"
          value={draft}
          onChangeText={setDraft}
          maxLength={MAX_MESSAGE_CHARS}
          multiline
        />
        {chat.isSending ? (
          <Pressable style={styles.sendButton} onPress={chat.stopAnswer} accessibilityLabel="Stop">
            <Text style={styles.sendButtonText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.sendButton} onPress={submitDraft} accessibilityLabel="Send">
            <Text style={styles.sendButtonText}>Send</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerAction: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  loading: { flex: 1 },
  listContent: { paddingVertical: 8, flexGrow: 1 },
  emptyText: { color: colors.mutedText, textAlign: 'center', marginTop: 48 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 6 },
  statusText: { color: colors.mutedText, fontSize: 13 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 10,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface,
  },
  input: { flex: 1, maxHeight: 120, fontSize: 16, color: colors.text, paddingHorizontal: 8, paddingVertical: 8 },
  sendButton: { backgroundColor: colors.accent, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 9 },
  sendButtonText: { color: colors.accentText, fontWeight: '600' },
});
