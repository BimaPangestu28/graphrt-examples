/**
 * Chat state for one signed-in user: loads the latest session from Supabase,
 * sends turns to graphrt serve, streams answers into the list and saves both
 * sides of every finished exchange.
 *
 * Lifecycle of an assistant bubble: streaming → saved (answer stored), or
 * dropped / failed (partial text kept, optional retry). A retry re-sends the
 * same user message with the same history; the user message is not stored twice.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildRunUrl, type AppConfig } from '../config.ts';
import { getAccessToken, refreshAccessToken } from '../auth/supabaseClient.ts';
import { openXhrEventStream } from '../net/eventStream.ts';
import { sleep } from '../net/sleep.ts';
import { createChatRepository, type ChatSession } from './chatRepository.ts';
import { runChatTurn, type ChatTurnOutcome } from './chatTurn.ts';
import {
  buildRunBody,
  formatLocalDate,
  selectRecentHistory,
  validateMessage,
  type ChatRole,
  type HistoryMessage,
} from './history.ts';

export type BubbleState = 'saved' | 'streaming' | 'dropped' | 'failed';

export interface ChatBubble {
  key: string;
  role: ChatRole;
  content: string;
  state: BubbleState;
  /** Why the answer is incomplete (dropped / failed). */
  notice?: string;
  /** What to resend when the user taps Retry. */
  retryRequest?: { message: string; history: HistoryMessage[] };
}

export interface ChatController {
  bubbles: ChatBubble[];
  isLoading: boolean;
  isSending: boolean;
  runningToolNames: string[];
  statusNotice: string | null;
  sendMessage: (message: string) => Promise<boolean>;
  retryAnswer: (bubbleKey: string) => void;
  stopAnswer: () => void;
  startNewChat: () => void;
}

let bubbleCounter = 0;
const nextBubbleKey = (): string => `bubble-${(bubbleCounter += 1)}`;

export function useChat(config: AppConfig, client: SupabaseClient, onSignInRequired: () => void): ChatController {
  const repository = useRef(createChatRepository(client)).current;
  const [bubbles, setBubbles] = useState<ChatBubble[]>([]);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [runningToolNames, setRunningToolNames] = useState<string[]>([]);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  /** Synchronous guard: state updates land too late to stop a quick double tap. */
  const isSendingRef = useRef(false);
  const markSending = useCallback((sending: boolean) => {
    isSendingRef.current = sending;
    setIsSending(sending);
  }, []);

  useEffect(() => {
    let isActive = true;
    loadLatestConversation(repository)
      .then((loaded) => {
        if (isActive) {
          setSession(loaded.session);
          setBubbles(loaded.bubbles);
        }
      })
      .catch((error: unknown) => isActive && setStatusNotice(describeError(error)))
      .finally(() => isActive && setIsLoading(false));
    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
    };
  }, [repository]);

  const updateBubble = useCallback((bubbleKey: string, changes: Partial<ChatBubble>) => {
    setBubbles((current) => current.map((bubble) => (bubble.key === bubbleKey ? { ...bubble, ...changes } : bubble)));
  }, []);

  const settleAnswer = useCallback(
    async (
      outcome: ChatTurnOutcome,
      bubbleKey: string,
      retryRequest: NonNullable<ChatBubble['retryRequest']>,
      activeSession: ChatSession,
    ) => {
      if (outcome.status === 'succeeded') {
        const answer = outcome.text || '(no answer)';
        updateBubble(bubbleKey, { content: answer, state: 'saved', notice: undefined, retryRequest: undefined });
        await repository
          .addMessage(activeSession.id, 'assistant', answer)
          .catch((error: unknown) => updateBubble(bubbleKey, { notice: describeError(error) }));
        return;
      }
      if (outcome.status === 'failed' && outcome.signInRequired) {
        onSignInRequired();
      }
      const notice = outcome.status === 'cancelled' ? 'Stopped.' : outcome.message;
      const canRetry = outcome.status !== 'failed' || outcome.canRetry;
      updateBubble(bubbleKey, {
        content: outcome.text,
        state: outcome.status === 'failed' ? 'failed' : 'dropped',
        notice,
        retryRequest: canRetry ? retryRequest : undefined,
      });
    },
    [onSignInRequired, repository, updateBubble],
  );

  const streamAnswer = useCallback(
    async (activeSession: ChatSession, bubbleKey: string, retryRequest: NonNullable<ChatBubble['retryRequest']>) => {
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      markSending(true);
      setStatusNotice(null);
      const outcome = await runChatTurn(
        {
          runUrl: buildRunUrl(config),
          body: buildRunBody({
            message: retryRequest.message,
            sessionId: activeSession.id,
            history: retryRequest.history,
            today: formatLocalDate(new Date()),
          }),
          signal: abortController.signal,
        },
        {
          openEventStream: openXhrEventStream,
          getAccessToken: () => getAccessToken(client),
          refreshAccessToken: () => refreshAccessToken(client),
          sleep,
        },
        {
          onText: (answerSoFar) => updateBubble(bubbleKey, { content: answerSoFar }),
          onToolActivity: setRunningToolNames,
          onRetryScheduled: ({ delayMs, reason }) =>
            setStatusNotice(
              `${reason === 'rate_limited' ? 'Rate limited' : 'Server busy'}, retrying in ${Math.ceil(delayMs / 1000)} s…`,
            ),
        },
      );
      abortControllerRef.current = null;
      setRunningToolNames([]);
      setStatusNotice(null);
      await settleAnswer(outcome, bubbleKey, retryRequest, activeSession);
      markSending(false);
    },
    [client, config, markSending, settleAnswer, updateBubble],
  );

  const sendMessage = useCallback(
    async (rawMessage: string): Promise<boolean> => {
      const message = rawMessage.trim();
      const validationError = validateMessage(message);
      if (validationError || isSendingRef.current) {
        setStatusNotice(validationError ?? null);
        return false;
      }
      markSending(true);
      try {
        const activeSession = session ?? (await repository.startSession(message));
        setSession(activeSession);
        const history = selectRecentHistory(savedHistory(bubbles), config.historyTurns);
        await repository.addMessage(activeSession.id, 'user', message);
        const answerKey = nextBubbleKey();
        setBubbles((current) => [
          ...current,
          { key: nextBubbleKey(), role: 'user', content: message, state: 'saved' },
          { key: answerKey, role: 'assistant', content: '', state: 'streaming' },
        ]);
        void streamAnswer(activeSession, answerKey, { message, history });
        return true;
      } catch (error) {
        setStatusNotice(describeError(error));
        markSending(false);
        return false;
      }
    },
    [bubbles, config.historyTurns, markSending, repository, session, streamAnswer],
  );

  const retryAnswer = useCallback(
    (bubbleKey: string) => {
      const bubble = bubbles.find((candidate) => candidate.key === bubbleKey);
      if (!bubble?.retryRequest || !session || isSendingRef.current) {
        return;
      }
      updateBubble(bubbleKey, { content: '', state: 'streaming', notice: undefined });
      void streamAnswer(session, bubbleKey, bubble.retryRequest);
    },
    [bubbles, session, streamAnswer, updateBubble],
  );

  const stopAnswer = useCallback(() => abortControllerRef.current?.abort(), []);

  const startNewChat = useCallback(() => {
    if (isSending) {
      return;
    }
    setSession(null);
    setBubbles([]);
    setStatusNotice(null);
  }, [isSending]);

  return {
    bubbles,
    isLoading,
    isSending,
    runningToolNames,
    statusNotice,
    sendMessage,
    retryAnswer,
    stopAnswer,
    startNewChat,
  };
}

async function loadLatestConversation(repository: ReturnType<typeof createChatRepository>) {
  const session = await repository.findLatestSession();
  if (!session) {
    return { session: null, bubbles: [] as ChatBubble[] };
  }
  const storedMessages = await repository.listMessages(session.id);
  const bubbles: ChatBubble[] = storedMessages.map((stored) => ({
    key: `stored-${stored.id}`,
    role: stored.role,
    content: stored.content,
    state: 'saved',
  }));
  return { session, bubbles };
}

/** Only stored messages count as history; partial answers are never sent back. */
function savedHistory(bubbles: readonly ChatBubble[]): HistoryMessage[] {
  return bubbles.filter((bubble) => bubble.state === 'saved').map(({ role, content }) => ({ role, content }));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
