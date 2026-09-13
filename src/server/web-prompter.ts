import { randomUUID } from 'node:crypto';
import type { ActionRequest } from '../safety/permissions.js';
import type { Answer, UI } from '../ui/ui.js';

export interface PendingPermission {
  id: string;
  tool: string;
  summary: string;
  risk: string;
  command?: string;
  path?: string;
  askedAt: number;
}

/**
 * Bridges the terminal's y/n/a prompt to a browser.
 *
 * The permission gate is a blocking call deep inside the agent loop. The browser
 * answers over HTTP, possibly seconds later, possibly never. So each request
 * becomes a pending promise keyed by an id; POST /api/permission resolves it.
 *
 * Safety default: if nobody answers within the timeout, the action is DENIED.
 * An unattended web agent must never fall open.
 */
export class WebPrompter {
  private readonly pending = new Map<string, { req: PendingPermission; resolve: (a: Answer) => void }>();
  private readonly timeoutMs: number;

  constructor(
    private readonly ui: UI,
    opts: { timeoutMs?: number; defaultAnswer?: Answer } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    this.defaultAnswer = opts.defaultAnswer ?? 'no';
    this.ui.ask = (req) => this.request(req);
  }

  private readonly defaultAnswer: Answer;

  get pendingCount(): number {
    return this.pending.size;
  }

  listPending(): PendingPermission[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  private async request(req: ActionRequest): Promise<Answer> {
    // No browser connected: fall back to the configured default rather than
    // hanging the agent forever.
    if (!this.ui.listener) {
      this.ui.note(`no web client attached — defaulting to "${this.defaultAnswer}"`);
      return this.defaultAnswer;
    }

    const id = randomUUID();
    const pending: PendingPermission = {
      id,
      tool: req.tool,
      summary: req.summary,
      risk: req.risk,
      ...(req.command ? { command: req.command } : {}),
      ...(req.path ? { path: req.path } : {}),
      askedAt: Date.now(),
    };

    return new Promise<Answer>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          this.ui.emitPermissionAnswer(id, this.defaultAnswer);
          this.ui.warn(`permission request timed out after ${this.timeoutMs / 1000}s — denied`);
          resolve(this.defaultAnswer);
        }
      }, this.timeoutMs);

      this.pending.set(id, {
        req: pending,
        resolve: (answer: Answer) => {
          clearTimeout(timer);
          resolve(answer);
        },
      });
      this.ui.emitPermission(id, {
        tool: req.tool,
        summary: req.summary,
        risk: req.risk,
        ...(req.command ? { command: req.command } : {}),
        ...(req.path ? { path: req.path } : {}),
      });
    });
  }

  /** Resolve a pending request. Returns false if the id is unknown or expired. */
  answer(id: string, answer: Answer): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    this.ui.emitPermissionAnswer(id, answer);
    entry.resolve(answer);
    return true;
  }

  /** Resolve everything outstanding (interrupt, shutdown, client disconnect). */
  cancelAll(answer: Answer = 'no'): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.answer(id, answer);
    return ids.length;
  }
}
