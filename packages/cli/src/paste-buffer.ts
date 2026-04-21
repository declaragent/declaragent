/**
 * Bracketed-paste state machine for the REPL's raw-stdin listener.
 *
 * **Why we own this instead of relying on Ink.** Ink's internal
 * keypress parser strips unknown escape sequences before `useInput`
 * sees them — including the `CSI 200~` / `CSI 201~` markers that
 * bracket a paste. By the time Ink surfaces the bytes as key events,
 * the `\n` mid-paste has already fired as a synthetic Return and
 * `ink-text-input` has treated it as a submission. The fix is to
 * listen to `process.stdin` in parallel with Ink, detect the markers
 * ourselves, and buffer the content until the end marker arrives.
 *
 * **Pattern source.** Architectural shape borrowed from Claude Code's
 * `parseMultipleKeypresses` tokenizer (see reference archive) — a
 * two-state FSM (`NORMAL` → `IN_PASTE`) that accumulates text between
 * markers and emits a single paste event on completion. We don't
 * replace Ink's parser; we coexist with it and ignore its effects
 * while paste is active (the REPL's `onChange` / `onSubmit` guards).
 *
 * **Chunk boundaries.** Pastes frequently span multiple `data`
 * events — the machine keeps its partial state across invocations
 * via {@link PasteMachine.feed}.
 *
 * @since 0.4.1
 */

export const PASTE_START_MARKER = '\x1b[200~';
export const PASTE_END_MARKER = '\x1b[201~';

export interface PasteSliceEvent {
  readonly type: 'slice';
  /** Paste content to append to the ongoing buffer. */
  readonly text: string;
}

export interface PasteEndEvent {
  readonly type: 'end';
}

export interface PasteStartEvent {
  readonly type: 'start';
}

export type PasteEvent = PasteStartEvent | PasteSliceEvent | PasteEndEvent;

/**
 * Stateful stream tokenizer. Feed it every `data` chunk from
 * `process.stdin` (string-decoded); it yields a sequence of
 * start/slice/end events. All non-paste bytes are silently dropped —
 * the REPL keeps using Ink's regular pipeline for those.
 *
 * The start marker can straddle a chunk boundary; the machine holds
 * any trailing bytes that *could* be the prefix of a start/end marker
 * until the next chunk disambiguates.
 */
export class PasteMachine {
  private inPaste = false;
  private pending = '';

  /**
   * Returns `true` iff the machine is currently consuming a paste
   * (start marker seen, end marker not yet). Callers use this to gate
   * `onChange` / `onSubmit` guards so Ink's pre-parsed chars don't
   * leak into the controlled input.
   */
  get active(): boolean {
    return this.inPaste;
  }

  /** Reset state — e.g. on REPL unmount. */
  reset(): void {
    this.inPaste = false;
    this.pending = '';
  }

  /**
   * Consume a chunk of raw stdin bytes (already utf-8 decoded).
   * Returns the events extracted, in order. Callers drive their own
   * side effects (set flag, append to buffer, flush) from the event
   * stream.
   */
  feed(chunk: string): PasteEvent[] {
    const events: PasteEvent[] = [];
    const s = this.pending + chunk;
    this.pending = '';
    let i = 0;

    while (i < s.length) {
      if (!this.inPaste) {
        const startIdx = s.indexOf(PASTE_START_MARKER, i);
        if (startIdx === -1) {
          // Could the chunk end mid-marker? Retain the longest suffix
          // of the remaining bytes that is a proper prefix of the
          // start marker — the next chunk may complete it.
          const holdBack = longestMarkerPrefixSuffix(s, i, PASTE_START_MARKER);
          if (holdBack > 0) this.pending = s.slice(s.length - holdBack);
          break;
        }
        i = startIdx + PASTE_START_MARKER.length;
        this.inPaste = true;
        events.push({ type: 'start' });
        continue;
      }

      // In paste: slurp up to the end marker.
      const endIdx = s.indexOf(PASTE_END_MARKER, i);
      if (endIdx === -1) {
        const holdBack = longestMarkerPrefixSuffix(s, i, PASTE_END_MARKER);
        const safeUpTo = s.length - holdBack;
        if (safeUpTo > i) {
          events.push({ type: 'slice', text: s.slice(i, safeUpTo) });
        }
        if (holdBack > 0) this.pending = s.slice(s.length - holdBack);
        break;
      }
      if (endIdx > i) {
        events.push({ type: 'slice', text: s.slice(i, endIdx) });
      }
      i = endIdx + PASTE_END_MARKER.length;
      this.inPaste = false;
      events.push({ type: 'end' });
    }

    return events;
  }
}

/**
 * Longest suffix of `s.slice(start)` that is a proper prefix of
 * `marker`. Returns 0 when no such suffix exists. Used to hold back
 * bytes that *could* be the start of the marker across a chunk
 * boundary.
 */
function longestMarkerPrefixSuffix(s: string, start: number, marker: string): number {
  const maxLen = Math.min(s.length - start, marker.length - 1);
  for (let n = maxLen; n > 0; n--) {
    if (s.slice(s.length - n) === marker.slice(0, n)) return n;
  }
  return 0;
}
