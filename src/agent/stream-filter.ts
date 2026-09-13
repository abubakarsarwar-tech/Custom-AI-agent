/**
 * Weak local models often print a tool call as prose JSON instead of using
 * native function calling:
 *
 *     Sure! Let me do that.
 *     ```json
 *     {"name": "write_file", "arguments": {...}}
 *     ```
 *
 * The repair layer (src/llm/repair.ts) recovers the call, but without this
 * filter the user watches a wall of JSON scroll past. StreamEcho holds back a
 * small tail of the stream so it can spot the opener *before* printing it,
 * then goes quiet for the rest of the block.
 */
const OPENER_RE =
  /(?:```(?:json|tool_call|function_call|tool)?\s*\n?\s*)?\{\s*"(?:name|tool|tool_name|function|function_name)"\s*:/;

const HOLDBACK = 72;

export class StreamEcho {
  private buf = '';
  private flushed = 0;
  private suppressedAt = -1;

  /** Feed a streamed chunk; returns text that is safe to print right now. */
  push(chunk: string): string {
    this.buf += chunk;
    if (this.suppressedAt >= 0) return '';

    // Search from a little behind the flush point so an opener straddling two
    // chunks is still caught in time.
    const searchFrom = Math.max(this.flushed, this.buf.length - HOLDBACK * 4);
    const window = this.buf.slice(searchFrom);
    const m = OPENER_RE.exec(window);
    if (m && searchFrom + m.index >= this.flushed) {
      this.suppressedAt = searchFrom + m.index;
      const out = this.buf.slice(this.flushed, this.suppressedAt);
      // Advance past what we just emitted, or revealAll()/finish() would
      // print this prose a second time.
      this.flushed = this.suppressedAt;
      return out;
    }

    const safe = Math.max(this.flushed, this.buf.length - HOLDBACK);
    const out = this.buf.slice(this.flushed, safe);
    this.flushed = safe;
    return out;
  }

  get isSuppressed(): boolean {
    return this.suppressedAt >= 0;
  }

  /** The full accumulated text, whether or not parts were hidden. */
  full(): string {
    return this.buf;
  }

  /**
   * Normal end of stream: release anything still held back.
   * If we suppressed a tool-call block, everything from the opener onward is
   * dropped — the harness is about to execute it, not display it.
   */
  finish(): string {
    if (this.suppressedAt >= 0) return '';
    const out = this.buf.slice(this.flushed);
    this.flushed = this.buf.length;
    return out;
  }

  /**
   * The JSON turned out NOT to be a tool call (the model was just showing an
   * example). Give the user back the text we hid.
   */
  revealAll(): string {
    const out = this.buf.slice(this.flushed);
    this.flushed = this.buf.length;
    this.suppressedAt = -1;
    return out;
  }
}
