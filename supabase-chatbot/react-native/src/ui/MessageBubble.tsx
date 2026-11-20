import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ChatBubble } from '../chat/useChat.ts';
import { colors } from './theme.ts';

interface MessageBubbleProps {
  bubble: ChatBubble;
  onRetry: (bubbleKey: string) => void;
}

/** One message. Incomplete answers keep their partial text and show a notice + Retry. */
export const MessageBubble = memo(function MessageBubble({ bubble, onRetry }: MessageBubbleProps) {
  const isUser = bubble.role === 'user';
  const isIncomplete = bubble.state === 'dropped' || bubble.state === 'failed';
  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
        {bubble.content ? (
          <Text style={isUser ? styles.userText : styles.assistantText} selectable>
            {bubble.content}
            {bubble.state === 'streaming' ? '▍' : ''}
          </Text>
        ) : bubble.state === 'streaming' ? (
          <Text style={styles.mutedText}>…</Text>
        ) : null}
        {bubble.notice ? (
          <Text style={[styles.notice, bubble.state === 'failed' ? styles.noticeFailed : null]}>{bubble.notice}</Text>
        ) : null}
        {isIncomplete && bubble.retryRequest ? (
          <Pressable onPress={() => onRetry(bubble.key)} accessibilityRole="button">
            <Text style={styles.retry}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: { paddingHorizontal: 12, paddingVertical: 4, flexDirection: 'row' },
  rowUser: { justifyContent: 'flex-end' },
  rowAssistant: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '85%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  userBubble: { backgroundColor: colors.userBubble },
  assistantBubble: { backgroundColor: colors.assistantBubble, borderColor: colors.border, borderWidth: 1 },
  userText: { color: colors.accentText, fontSize: 16 },
  assistantText: { color: colors.text, fontSize: 16 },
  mutedText: { color: colors.mutedText, fontSize: 16 },
  notice: { color: colors.warning, fontSize: 13 },
  noticeFailed: { color: colors.danger },
  retry: { color: colors.accent, fontWeight: '600', fontSize: 14, paddingVertical: 2 },
});
