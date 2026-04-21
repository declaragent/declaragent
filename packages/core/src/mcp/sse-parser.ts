/**
 * Minimal Server-Sent Events frame parser.
 *
 * Shared by the SSE transport (slice 2c) and the streamable-HTTP
 * transport (also 2c) since the 2025-03-26 spec piggybacks JSON-RPC
 * messages on `text/event-stream` response bodies.
 *
 * Implements the subset of the WHATWG EventSource parser we actually
 * need: multi-line `data:` accumulation, per-frame `event:` + `id:`
 * fields, CR/LF/CRLF line terminators, and empty-line = dispatch.
 * Ignores retry/comment fields (not used by MCP).
 *
 * @since 0.5.0-slice.2c
 */

export interface SSEFrame {
  /** `event:` field; `""` (empty) when absent, matching the DOM spec default "message". */
  event: string;
  /** Concatenated `data:` lines joined by `\n`. */
  data: string;
  /** `id:` field if present; retained as the last-event-id would be. */
  id: string | undefined;
}

/**
 * Streaming line-oriented parser. Call `push(bytes)` as chunks arrive;
 * dispatch each returned frame. Call `flush()` when the stream ends to
 * emit any trailing frame that didn't finish with a blank line.
 */
export class SSEFrameParser {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private currentEvent = '';
  private currentData: string[] = [];
  private currentId: string | undefined;

  push(chunk: Uint8Array | string): SSEFrame[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const frames: SSEFrame[] = [];
    let lineEnd = this.nextLineEnd();
    while (lineEnd !== -1) {
      const rawLine = this.buffer.slice(0, lineEnd);
      // Advance past the terminator (could be \n, \r, or \r\n).
      const skip =
        this.buffer.charAt(lineEnd) === '\r' && this.buffer.charAt(lineEnd + 1) === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(lineEnd + skip);
      if (rawLine === '') {
        // Blank line → dispatch current frame (if any data).
        if (
          this.currentData.length > 0 ||
          this.currentEvent !== '' ||
          this.currentId !== undefined
        ) {
          frames.push({
            event: this.currentEvent,
            data: this.currentData.join('\n'),
            id: this.currentId,
          });
        }
        this.currentEvent = '';
        this.currentData = [];
        // Per the spec, last-event-id persists across frames; we keep it.
      } else {
        this.processLine(rawLine);
      }
      lineEnd = this.nextLineEnd();
    }
    return frames;
  }

  flush(): SSEFrame | undefined {
    if (this.currentData.length === 0 && this.currentEvent === '') return undefined;
    const frame: SSEFrame = {
      event: this.currentEvent,
      data: this.currentData.join('\n'),
      id: this.currentId,
    };
    this.currentEvent = '';
    this.currentData = [];
    return frame;
  }

  private nextLineEnd(): number {
    for (let i = 0; i < this.buffer.length; i += 1) {
      const c = this.buffer.charAt(i);
      if (c === '\n' || c === '\r') return i;
    }
    return -1;
  }

  private processLine(line: string): void {
    if (line.startsWith(':')) return; // comment
    const colonIdx = line.indexOf(':');
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
    // Spec: strip exactly one leading space from the value.
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      this.currentEvent = value;
    } else if (field === 'data') {
      this.currentData.push(value);
    } else if (field === 'id') {
      if (!value.includes('\0')) this.currentId = value;
    }
    // retry: field intentionally ignored.
  }
}
