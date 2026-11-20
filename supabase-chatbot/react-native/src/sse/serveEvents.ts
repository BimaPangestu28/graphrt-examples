/**
 * Maps raw SSE events from `graphrt serve` to the few things the chat UI needs.
 *
 * The answer text comes only from `response` events ({node_id, text, is_final});
 * everything else (`node_chunk`, `node_started`...) is ignored except
 * `node_progress` tool_call / tool_result, which drive the "looking it up"
 * indicator, and the terminal run events.
 */
import type { SseEvent } from './sseParser.ts';

export type ServeStreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_started'; callId: string; toolName: string }
  | { kind: 'tool_finished'; callId: string }
  | { kind: 'run_succeeded' }
  | { kind: 'run_failed'; error: string; errorType: string }
  | { kind: 'run_aborted' }
  | { kind: 'run_paused' }
  | { kind: 'ignored' };

/** Events after which serve closes the stream. */
export const TERMINAL_KINDS: ReadonlySet<ServeStreamEvent['kind']> = new Set([
  'run_succeeded',
  'run_failed',
  'run_aborted',
  'run_paused',
]);

const IGNORED: ServeStreamEvent = { kind: 'ignored' };

/**
 * Interpret one SSE event from a run stream.
 *
 * @param event - A parsed SSE event (SseEvent)
 * @returns What it means for the chat (ServeStreamEvent); malformed JSON is ignored
 */
export function interpretServeEvent(event: SseEvent): ServeStreamEvent {
  const payload = parseJsonObject(event.data);
  switch (event.type) {
    case 'response':
      return interpretResponse(payload);
    case 'node_progress':
      return interpretProgress(payload);
    case 'run_succeeded':
      return { kind: 'run_succeeded' };
    case 'run_failed':
      return {
        kind: 'run_failed',
        error: readString(payload?.error) || 'The run failed.',
        errorType: readString(payload?.error_type),
      };
    case 'run_aborted':
      return { kind: 'run_aborted' };
    case 'run_paused':
      return { kind: 'run_paused' };
    default:
      return IGNORED;
  }
}

function interpretResponse(payload: Record<string, unknown> | undefined): ServeStreamEvent {
  const text = readString(payload?.text);
  return text ? { kind: 'text', text } : IGNORED;
}

function interpretProgress(payload: Record<string, unknown> | undefined): ServeStreamEvent {
  const progressData = asObject(payload?.data);
  const callId = readString(progressData?.id);
  if (!callId) {
    return IGNORED;
  }
  if (payload?.name === 'tool_call') {
    return { kind: 'tool_started', callId, toolName: readString(progressData?.name) };
  }
  if (payload?.name === 'tool_result') {
    return { kind: 'tool_finished', callId };
  }
  return IGNORED;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
