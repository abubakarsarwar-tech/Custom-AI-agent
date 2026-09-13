import type { ServerResponse } from 'node:http';
import type { AgentRuntime } from '../agent/runtime.js';
import type { UIEvent } from '../ui/ui.js';
import type { WebPrompter } from './web-prompter.js';

interface Client {
  id: number;
  res: ServerResponse;
}

export interface Snapshot {
  model: string;
  provider: string;
  workspace: string;
  permissionMode: string;
  numCtx: number;
  busy: boolean;
  stats: string;
  plan: Array<{ content: string; status: string }>;
  skills: Array<{ name: string; description: string; loaded: boolean; tokens: number; source: string }>;
  memory: { count: number; lessons: Array<{ id: string; text: string; tags: string[]; score: number; source: string }> };
  history: Array<{ role: string; text: string }>;
  tools: string[];
  ollama: { ok: boolean; error?: string };
  auth: { required: boolean };
}

/**
 * One agent, many browser tabs.
 *
 * Holds the AgentRuntime and fans its UI events out to every connected SSE
 * client. A late-joining client gets a full snapshot first, so a refresh never
 * loses the conversation.
 */
export class WebSession {
  private clients = new Set<Client>();
  private nextClientId = 1;
  private busy = false;
  private ac: AbortController | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastError: string | null = null;

  constructor(
    readonly rt: AgentRuntime,
    readonly prompter: WebPrompter,
    private readonly opts: { authRequired: boolean },
  ) {
    // The terminal UI keeps working exactly as before; this only mirrors.
    rt.ui.listener = (event: UIEvent) => this.broadcast(event);
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /* ---------------- SSE ---------------- */

  subscribe(res: ServerResponse): () => void {
    const client: Client = { id: this.nextClientId++, res };
    this.clients.add(client);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and friends buffer SSE by default, which looks like a hung UI.
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.sendTo(client, 'snapshot', this.snapshot());

    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        for (const c of this.clients) {
          try {
            c.res.write(': ping\n\n');
          } catch {
            /* ignore */
          }
        }
      }, 25_000);
      this.heartbeat.unref?.();
    }

    // Re-send anything the client missed while it was connecting.
    for (const p of this.prompter.listPending()) {
      this.sendTo(client, 'permission_request', p);
    }

    return () => {
      this.clients.delete(client);
      if (this.clients.size === 0 && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    };
  }

  private sendTo(client: Client, event: string, data: unknown): void {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.clients.delete(client);
    }
  }

  broadcast(event: UIEvent | { type: string; [k: string]: unknown }): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.res.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /* ---------------- turns ---------------- */

  async send(text: string, opts: { skill?: string; queue?: boolean } = {}): Promise<{
    ok: boolean;
    error?: string;
  }> {
    if (this.busy) {
      if (!opts.queue) {
        return { ok: false, error: 'The agent is already working on something. Stop it first.' };
      }
      // Wait for the current turn instead of rejecting.
      while (this.busy) await new Promise((r) => setTimeout(r, 150));
    }

    this.busy = true;
    this.lastError = null;
    this.ac = new AbortController();
    const ac = this.ac;

    try {
      if (opts.skill && this.rt.preloadSkill(opts.skill)) {
        this.rt.ui.note(`skill loaded: ${opts.skill}`);
        this.rt.ui.emitSkill(opts.skill);
      }
      const result = await this.rt.send(text, ac.signal);
      this.broadcast({ type: 'turn_end', stats: this.rt.statsLine(), answer: result.answer });
      if (result.error) this.lastError = result.error;
      return result.error ? { ok: false, error: result.error } : { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.broadcast({ type: 'error', text: msg });
      return { ok: false, error: msg };
    } finally {
      this.busy = false;
      this.ac = null;
      this.prompter.cancelAll('no');
    }
  }

  interrupt(): boolean {
    if (!this.ac) return false;
    this.ac.abort();
    this.prompter.cancelAll('no');
    this.broadcast({ type: 'note', text: 'interrupted by user' });
    return true;
  }

  /* ---------------- state ---------------- */

  snapshot(): Snapshot {
    const rt = this.rt;
    return {
      model: rt.config.model,
      provider: rt.config.provider,
      workspace: rt.config.workspace,
      permissionMode: rt.config.permissionMode,
      numCtx: rt.config.numCtx,
      busy: this.busy,
      stats: rt.statsLine(),
      plan: rt.session.plan.all().map((t) => ({ content: t.content, status: t.status })),
      skills: rt.skills.all().map((s) => ({
        name: s.name,
        description: s.description,
        loaded: rt.skills.isLoaded(s.name),
        tokens: s.bodyTokens,
        source: s.source,
      })),
      memory: {
        count: rt.memory?.count ?? 0,
        lessons: (rt.memory?.all() ?? [])
          .slice(-50)
          .reverse()
          .map((l) => ({ id: l.id, text: l.text, tags: l.tags, score: l.score, source: l.source })),
      },
      history: rt.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .filter((m) => !m.content.startsWith('['))
        .map((m) => ({ role: m.role, text: m.content }))
        .slice(-60),
      tools: rt.registry.names,
      ollama: { ok: this.lastError === null, ...(this.lastError ? { error: this.lastError } : {}) },
      auth: { required: this.opts.authRequired },
    };
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.prompter.cancelAll('no');
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
