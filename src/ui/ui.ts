import type { ActionRequest } from '../safety/permissions.js';
import { c, spinnerFrames } from '../util/ansi.js';

export type Answer = 'yes' | 'no' | 'always';

/**
 * Structured events emitted alongside the terminal output.
 *
 * A browser cannot render ANSI escapes or a spinner, and it needs to know where
 * one tool call ends and the next begins. So every interesting thing the UI
 * does is also published here, and the web server forwards it as SSE. The
 * terminal path is unchanged; this is purely additive.
 */
export type UIEvent =
  | { type: 'assistant_delta'; text: string }
  | { type: 'assistant_end' }
  | { type: 'tool_start'; name: string; summary: string }
  | { type: 'tool_end'; name: string; ok: boolean; ms: number; preview?: string }
  | { type: 'note'; text: string }
  | { type: 'warn'; text: string }
  | { type: 'error'; text: string }
  | { type: 'spinner'; label: string }
  | { type: 'spinner_stop' }
  | { type: 'permission_request'; id: string; tool: string; summary: string; risk: string; command?: string; path?: string }
  | { type: 'permission_response'; id: string; answer: Answer }
  | { type: 'turn_end'; stats: string }
  | { type: 'plan'; items: Array<{ content: string; status: string }> }
  | { type: 'skill_loaded'; name: string }
  | { type: 'log'; text: string };

export type UIListener = (event: UIEvent) => void;

export interface UIOptions {
  /** Suppress everything except the model's answer (for pipes / CI). */
  quiet?: boolean;
  /** Show tool traces. */
  verbose?: boolean;
  interactive?: boolean;
  /** Where output goes. Override it to capture text in tests. */
  write?: (s: string) => void;
}

/**
 * All human-facing output goes through this object. Keeping it in one place is
 * what lets the same agent core drive a REPL, a one-shot CLI, and the tests.
 */
export class UI {
  private readonly quiet: boolean;
  private readonly verbose: boolean;
  private readonly sink: (s: string) => void;
  readonly interactive: boolean;

  /** Replaced by the REPL with a real readline prompt; null = non-interactive. */
  ask: ((req: ActionRequest) => Promise<Answer>) | null = null;
  /** Used when there is no interactive prompt available. */
  nonInteractiveAnswer: Answer = 'no';

  /** Set by the web server to mirror everything to the browser. */
  listener: UIListener | null = null;

  private emit(event: UIEvent): void {
    try {
      this.listener?.(event);
    } catch {
      /* a broken SSE client must never break the agent */
    }
  }

  private spinTimer: NodeJS.Timeout | null = null;
  /** True between a spinner start and stop, independent of whether it is drawn. */
  private spinActive = false;
  private spinIndex = 0;
  private spinLabel = '';
  private streaming = false;

  constructor(opts: UIOptions = {}) {
    this.quiet = opts.quiet ?? false;
    this.verbose = opts.verbose ?? false;
    this.interactive = opts.interactive ?? false;
    this.sink = opts.write ?? ((s: string) => process.stdout.write(s));
  }

  /* ---------------- raw output ---------------- */

  private out(s: string): void {
    this.sink(s);
  }

  raw(s: string): void {
    this.out(s);
  }

  line(s = ''): void {
    this.out(`${s}\n`);
  }

  dim(s: string): void {
    if (this.quiet) return;
    this.out(`${c.dim(s)}\n`);
  }

  /** Structured log line for the web UI's activity feed. */
  log(s: string): void {
    this.emit({ type: 'log', text: s });
  }

  emitSkill(name: string): void {
    this.emit({ type: 'skill_loaded', name });
  }

  emitPlan(items: Array<{ content: string; status: string }>): void {
    this.emit({ type: 'plan', items });
  }

  emitTurnEnd(stats: string): void {
    this.emit({ type: 'turn_end', stats });
  }

  emitPermission(id: string, detail: Omit<Extract<UIEvent, { type: 'permission_request' }>, 'type' | 'id'>): void {
    this.emit({ type: 'permission_request', id, ...detail });
  }

  emitPermissionAnswer(id: string, answer: Answer): void {
    this.emit({ type: 'permission_response', id, answer });
  }

  info(s: string): void {
    if (this.quiet) return;
    this.out(`${c.cyan('ℹ')} ${s}\n`);
  }

  success(s: string): void {
    if (this.quiet) return;
    this.out(`${c.green('✔')} ${s}\n`);
  }

  warn(s: string): void {
    this.emit({ type: 'warn', text: s });
    if (this.quiet) return;
    this.out(`${c.yellow('⚠')} ${s}\n`);
  }

  error(s: string): void {
    this.emit({ type: 'error', text: s });
    this.out(`${c.red('✖')} ${s}\n`);
  }

  /** Permission layer uses this for one-line policy notes. */
  note(s: string): void {
    this.emit({ type: 'note', text: s });
    if (this.quiet && !this.verbose) return;
    this.dim(`  ${s}`);
  }

  banner(title: string, lines: string[] = []): void {
    if (this.quiet) return;
    this.line();
    this.out(`${c.bold(c.magenta(title))}\n`);
    for (const l of lines) this.out(`${c.dim('  ' + l)}\n`);
  }

  /* ---------------- streaming assistant text ---------------- */

  beginAssistant(): void {
    this.stopSpinner();
    // `streaming` tracks the message, not the terminal: assistant_end must
    // reach the web UI even when quiet mode suppresses the decoration.
    if (!this.streaming) {
      this.streaming = true;
      if (!this.quiet) this.out(c.green('\n● '));
    }
  }

  chunk(text: string): void {
    this.stopSpinner();
    this.emit({ type: 'assistant_delta', text });
    this.out(text);
  }

  endAssistant(): void {
    if (this.streaming) {
      this.streaming = false;
      if (!this.quiet) this.out('\n');
      this.emit({ type: 'assistant_end' });
    }
  }

  /* ---------------- tool trace ---------------- */

  toolStart(name: string, summary: string): void {
    this.endAssistant();
    this.emit({ type: 'tool_start', name, summary });
    if (this.quiet && !this.verbose) return;
    this.out(`${c.blue('⚒')} ${c.bold(name)} ${c.dim(summary.slice(0, 160))}\n`);
  }

  toolDetail(text: string): void {
    if (this.quiet || !this.verbose) return;
    for (const l of text.split('\n')) this.out(c.dim(`  │ ${l}`) + '\n');
  }

  toolEnd(name: string, ok: boolean, ms: number, preview?: string): void {
    this.emit({ type: 'tool_end', name, ok, ms, ...(preview ? { preview } : {}) });
    if (this.quiet && !this.verbose) return;
    const mark = ok ? c.green('✔') : c.red('✖');
    this.out(`  ${mark} ${c.dim(`${name} · ${ms}ms`)}\n`);
    // Errors are shown even without --verbose: a bare ✖ tells nobody anything.
    if (preview && (this.verbose || !ok)) {
      for (const l of preview.split('\n').slice(0, 8)) {
        this.out(`${ok ? c.dim('  │ ') : c.red('  │ ')}${ok ? c.dim(l) : c.red(l)}\n`);
      }
    }
  }

  /* ---------------- spinner ---------------- */

  startSpinner(label: string): void {
    const alreadySpinning = this.spinActive;
    if (this.quiet || !process.stdout.isTTY) {
      if (!alreadySpinning) this.emit({ type: 'spinner', label });
      this.spinActive = true;
      this.spinLabel = label;
      return;
    }
    this.stopSpinner();
    if (!alreadySpinning) this.emit({ type: 'spinner', label });
    this.spinActive = true;
    this.spinLabel = label;
    this.spinIndex = 0;
    const draw = (): void => {
      const frame = spinnerFrames[this.spinIndex % spinnerFrames.length] ?? '·';
      this.spinIndex += 1;
      this.sink(`\r${c.cyan(frame)} ${c.dim(this.spinLabel)}   `);
    };
    draw();
    this.spinTimer = setInterval(draw, 90);
  }

  setSpinnerLabel(label: string): void {
    if (this.spinActive && label !== this.spinLabel) this.emit({ type: 'spinner', label });
    this.spinLabel = label;
  }

  stopSpinner(): void {
    if (this.spinActive) {
      this.spinActive = false;
      this.emit({ type: 'spinner_stop' });
    }
    if (this.spinTimer) {
      clearInterval(this.spinTimer);
      this.spinTimer = null;
      if (!this.quiet && process.stdout.isTTY) this.sink('\r\u001b[2K');
    }
  }

  /* ---------------- permissions ---------------- */

  async confirm(req: ActionRequest): Promise<Answer> {
    this.stopSpinner();
    this.endAssistant();
    if (this.ask) return this.ask(req);
    if (this.quiet) this.nonInteractiveAnswer = 'yes'; // piped mode: --yes implied
    return this.nonInteractiveAnswer;
  }

  renderRequest(req: ActionRequest): string {
    const riskColor =
      req.risk === 'high' ? c.red : req.risk === 'medium' ? c.yellow : c.dim;
    const head = `${riskColor(`[${req.risk.toUpperCase()}]`)} ${c.bold(req.tool)} — ${req.summary}`;
    return head;
  }
}
