import type { ActionRequest } from '../safety/permissions.js';
import { c, spinnerFrames } from '../util/ansi.js';

export type Answer = 'yes' | 'no' | 'always';

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

  private spinTimer: NodeJS.Timeout | null = null;
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

  info(s: string): void {
    if (this.quiet) return;
    this.out(`${c.cyan('ℹ')} ${s}\n`);
  }

  success(s: string): void {
    if (this.quiet) return;
    this.out(`${c.green('✔')} ${s}\n`);
  }

  warn(s: string): void {
    if (this.quiet) return;
    this.out(`${c.yellow('⚠')} ${s}\n`);
  }

  error(s: string): void {
    this.out(`${c.red('✖')} ${s}\n`);
  }

  /** Permission layer uses this for one-line policy notes. */
  note(s: string): void {
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
    if (this.quiet) return;
    if (!this.streaming) {
      this.out(c.green('\n● '));
      this.streaming = true;
    }
  }

  chunk(text: string): void {
    this.stopSpinner();
    this.out(text);
  }

  endAssistant(): void {
    if (this.streaming) {
      this.out('\n');
      this.streaming = false;
    }
  }

  /* ---------------- tool trace ---------------- */

  toolStart(name: string, summary: string): void {
    this.endAssistant();
    if (this.quiet && !this.verbose) return;
    this.out(`${c.blue('⚒')} ${c.bold(name)} ${c.dim(summary.slice(0, 160))}\n`);
  }

  toolDetail(text: string): void {
    if (this.quiet || !this.verbose) return;
    for (const l of text.split('\n')) this.out(c.dim(`  │ ${l}`) + '\n');
  }

  toolEnd(name: string, ok: boolean, ms: number, preview?: string): void {
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
    if (this.quiet || !process.stdout.isTTY) return;
    this.stopSpinner();
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
    this.spinLabel = label;
  }

  stopSpinner(): void {
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
