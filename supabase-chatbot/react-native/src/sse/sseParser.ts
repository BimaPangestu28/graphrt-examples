/**
 * Incremental Server-Sent Events parser (WHATWG "event stream interpretation").
 *
 * Network chunks can split a line, a field or even a `\r\n` pair anywhere, so the
 * parser keeps the unfinished tail between `push` calls. It has no I/O and no
 * dependencies, which keeps it unit-testable under plain Node.
 *
 * @example
 * const parser = new SseParser();
 * for (const event of parser.push('event: response\ndata: {"text":"Hi"}\n\n')) {
 *   console.log(event.type, event.data); // "response" '{"text":"Hi"}'
 * }
 */

/** One dispatched SSE message. `type` defaults to "message" like `EventSource`. */
export interface SseEvent {
  type: string;
  data: string;
  id?: string;
}

const DEFAULT_EVENT_TYPE = 'message';

export class SseParser {
  private pendingText = '';
  private eventType = '';
  private dataLines: string[] = [];
  private lastEventId: string | undefined;
  /** A chunk ended with `\r`: a `\n` starting the next chunk belongs to it. */
  private skipLeadingLineFeed = false;

  /**
   * Feed the next chunk of the response body.
   *
   * @param chunk - Newly received text (string)
   * @returns Events completed by this chunk, in stream order (SseEvent[])
   */
  push(chunk: string): SseEvent[] {
    let text = chunk;
    if (this.skipLeadingLineFeed && text.startsWith('\n')) {
      text = text.slice(1);
    }
    this.skipLeadingLineFeed = false;
    this.pendingText += text;

    const completedEvents: SseEvent[] = [];
    let lineStart = 0;
    for (let index = 0; index < this.pendingText.length; index += 1) {
      const character = this.pendingText[index];
      if (character !== '\n' && character !== '\r') {
        continue;
      }
      const line = this.pendingText.slice(lineStart, index);
      if (character === '\r') {
        if (index + 1 === this.pendingText.length) {
          this.skipLeadingLineFeed = true;
        } else if (this.pendingText[index + 1] === '\n') {
          index += 1;
        }
      }
      lineStart = index + 1;
      const event = this.processLine(line);
      if (event) {
        completedEvents.push(event);
      }
    }
    this.pendingText = this.pendingText.slice(lineStart);
    return completedEvents;
  }

  /**
   * Signal the end of the stream. Per the spec an event without its closing
   * blank line is discarded, so this only clears state.
   */
  end(): void {
    this.pendingText = '';
    this.resetEvent();
    this.skipLeadingLineFeed = false;
  }

  private processLine(line: string): SseEvent | undefined {
    if (line === '') {
      return this.dispatchEvent();
    }
    if (line.startsWith(':')) {
      return undefined; // comment, e.g. a keep-alive
    }
    const colonIndex = line.indexOf(':');
    const fieldName = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let fieldValue = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (fieldValue.startsWith(' ')) {
      fieldValue = fieldValue.slice(1);
    }
    switch (fieldName) {
      case 'event':
        this.eventType = fieldValue;
        break;
      case 'data':
        this.dataLines.push(fieldValue);
        break;
      case 'id':
        if (!fieldValue.includes('\u0000')) {
          this.lastEventId = fieldValue;
        }
        break;
      default:
        break; // `retry` and unknown fields are ignored: reconnection is ours
    }
    return undefined;
  }

  private dispatchEvent(): SseEvent | undefined {
    if (this.dataLines.length === 0) {
      this.resetEvent();
      return undefined;
    }
    const event: SseEvent = {
      type: this.eventType || DEFAULT_EVENT_TYPE,
      data: this.dataLines.join('\n'),
    };
    if (this.lastEventId !== undefined) {
      event.id = this.lastEventId;
    }
    this.resetEvent();
    return event;
  }

  private resetEvent(): void {
    this.eventType = '';
    this.dataLines = [];
  }
}
