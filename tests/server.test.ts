import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer, generateToken, BUNDLED_WEB_DIR, type StartedServer } from '../src/server/http.js';
import { WebPrompter } from '../src/server/web-prompter.js';
import type { UIEvent } from '../src/ui/ui.js';
import type { ActionRequest } from '../src/safety/permissions.js';
import { makeRuntime, makeSandbox, silentUI, type Sandbox } from './helpers.js';
import type { MockTurn } from '../src/llm/mock.js';
import type { AgentConfig } from '../src/config.js';

/* ---------------- test plumbing ---------------- */

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop();
    await fn?.();
  }
});

interface Harness {
  base: string;
  sbx: Sandbox;
  started: StartedServer;
  rt: Awaited<ReturnType<typeof makeRuntime>>['rt'];
}

async function serve(
  turns: MockTurn[],
  over: Record<string, unknown> = {},
  serveOpts: { token?: string; permissionTimeoutMs?: number } = {},
): Promise<Harness> {
  const sbx = await makeSandbox();
  cleanups.push(() => sbx.cleanup());

  const { rt } = await makeRuntime(sbx.dir, turns, {
    permissionMode: 'auto',
    memoryEnabled: true,
    ...over,
  } as Partial<AgentConfig>);

  const started = await startServer(rt, {
    host: '127.0.0.1',
    port: 0, // any free port — the server reports what it bound
    webDir: BUNDLED_WEB_DIR,
    ...serveOpts,
  });
  cleanups.push(() => started.close());

  return { base: `http://127.0.0.1:${started.port}`, sbx, started, rt };
}

async function get(h: Harness, url: string, token?: string): Promise<Response> {
  return fetch(h.base + url, { headers: token ? { 'X-LCA-Token': token } : {} });
}

async function post(
  h: Harness,
  url: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['X-LCA-Token'] = token;
  const res = await fetch(h.base + url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  return { status: res.status, data: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function del(h: Harness, url: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(h.base + url, { method: 'DELETE' });
  const text = await res.text();
  return { status: res.status, data: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** A minimal SSE reader: queues parsed frames and can wait for one by type. */
class SseClient {
  readonly events: Array<{ type: string; data: Record<string, unknown> }> = [];
  private ac = new AbortController();
  private waiters: Array<(e: { type: string; data: Record<string, unknown> }) => void> = [];
  /** Resolves once the stream is OPEN — not when it ends, which is never. */
  private opened: Promise<void>;
  private failure: Error | null = null;

  constructor(base: string, token?: string) {
    const url = `${base}/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    let markOpen!: () => void;
    this.opened = new Promise<void>((resolve) => {
      markOpen = resolve;
    });
    void this.run(url, markOpen);
  }

  private async run(url: string, markOpen: () => void): Promise<void> {
    let res: Response;
    try {
      res = await fetch(url, { signal: this.ac.signal });
    } catch (err) {
      this.failure = err instanceof Error ? err : new Error(String(err));
      markOpen();
      return;
    }
    if (!res.ok || !res.body) {
      this.failure = new Error(`SSE connect failed: ${res.status}`);
      markOpen();
      return;
    }
    markOpen();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      let value: Uint8Array | undefined;
      let done = false;
      try {
        ({ value, done } = await reader.read());
      } catch (err) {
        if (!this.ac.signal.aborted) {
          this.failure = err instanceof Error ? err : new Error(String(err));
        }
        break;
      }
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const parsed = this.parse(frame);
        if (!parsed) continue;
        this.events.push(parsed);
        const waiters = this.waiters.splice(0, this.waiters.length);
        for (const w of waiters) w(parsed);
      }
    }
  }

  private parse(frame: string): { type: string; data: Record<string, unknown> } | null {
    let type = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // heartbeat comment
      if (line.startsWith('event: ')) type = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (dataLines.length === 0) return null;
    return { type, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> };
  }

  /** Resolve as soon as an event of this type arrives (past or future). */
  async waitFor(type: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    await this.opened;
    if (this.failure) throw this.failure;
    const existing = this.events.find((e) => e.type === type);
    if (existing) return existing.data;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for "${type}"`)), timeoutMs);
      const check = (e: { type: string; data: Record<string, unknown> }): void => {
        if (e.type === type) {
          clearTimeout(timer);
          resolve(e.data);
        } else {
          this.waiters.push(check);
        }
      };
      this.waiters.push(check);
    });
  }

  close(): void {
    this.ac.abort();
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const w of waiters) w({ type: '\u0000closed', data: {} });
  }
}

function openSse(h: Harness, token?: string): SseClient {
  const client = new SseClient(h.base, token);
  cleanups.push(async () => client.close());
  return client;
}

const writeTurn: MockTurn[] = [
  {
    text: 'Writing the file now.',
    toolCalls: [{ name: 'write_file', arguments: { path: 'out.txt', content: 'hello\n' } }],
  },
  { text: 'Done — out.txt is written.' },
];

/* ---------------- WebPrompter ---------------- */

function askReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    tool: 'bash',
    summary: 'run a shell command',
    risk: 'high',
    command: 'rm -rf build',
    ...over,
  } as ActionRequest;
}

describe('WebPrompter', () => {
  it('turns a blocking ask into a browser round-trip', async () => {
    const ui = silentUI();
    const seen: UIEvent[] = [];
    ui.listener = (e) => seen.push(e);
    const prompter = new WebPrompter(ui, { timeoutMs: 5000 });

    const pending = ui.ask!(askReq());
    const req = seen.find((e) => e.type === 'permission_request') as
      | { type: 'permission_request'; id: string; tool: string; risk: string }
      | undefined;
    expect(req?.tool).toBe('bash');
    expect(req?.risk).toBe('high');
    expect(prompter.pendingCount).toBe(1);

    expect(prompter.answer(req!.id, 'yes')).toBe(true);
    await expect(pending).resolves.toBe('yes');
    expect(prompter.pendingCount).toBe(0);
    expect(seen.some((e) => e.type === 'permission_response')).toBe(true);
  });

  it('DENIES when nobody answers in time — an unattended agent must not fall open', async () => {
    const ui = silentUI();
    ui.listener = () => {};
    const prompter = new WebPrompter(ui, { timeoutMs: 30 });

    await expect(ui.ask!(askReq())).resolves.toBe('no');
    expect(prompter.pendingCount).toBe(0);
  });

  it('honours a configured default answer (auto mode)', async () => {
    const ui = silentUI();
    ui.listener = () => {};
    const prompter = new WebPrompter(ui, { timeoutMs: 25, defaultAnswer: 'yes' });
    await expect(ui.ask!(askReq())).resolves.toBe('yes');
  });

  it('answers immediately when no browser is attached', async () => {
    const ui = silentUI();
    const prompter = new WebPrompter(ui, { timeoutMs: 5000 });
    expect(ui.listener).toBeNull();
    await expect(ui.ask!(askReq())).resolves.toBe('no');
    expect(prompter.pendingCount).toBe(0);
  });

  it('rejects unknown or already-answered ids', async () => {
    const ui = silentUI();
    ui.listener = () => {};
    const prompter = new WebPrompter(ui, {});
    expect(prompter.answer('l_nope', 'yes')).toBe(false);
  });

  it('cancelAll resolves every outstanding request', async () => {
    const ui = silentUI();
    ui.listener = () => {};
    const prompter = new WebPrompter(ui, { timeoutMs: 5000 });

    const a = ui.ask!(askReq({ tool: 'write_file' }));
    const b = ui.ask!(askReq({ tool: 'edit_file' }));
    expect(prompter.pendingCount).toBe(2);
    expect(prompter.listPending().map((p) => p.tool).sort()).toEqual(['edit_file', 'write_file']);

    expect(prompter.cancelAll('no')).toBe(2);
    await expect(a).resolves.toBe('no');
    await expect(b).resolves.toBe('no');
  });
});

/* ---------------- static files ---------------- */

describe('static web UI', () => {
  it('serves the app shell, stylesheet and script', async () => {
    const h = await serve([{ text: 'hi' }]);

    const html = await get(h, '/');
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toMatch(/text\/html/);
    const body = await html.text();
    expect(body).toContain('<title>LCA');
    expect(body).toContain('id="transcript"');

    const css = await get(h, '/styles.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toMatch(/text\/css/);

    const js = await get(h, '/app.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(await js.text()).toContain('EventSource');
  });

  it('cannot be walked out of the web folder', async () => {
    const h = await serve([{ text: 'hi' }]);
    for (const attack of [
      '/../../etc/passwd',
      '/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
      '/..%2f..%2f..%2fetc%2fpasswd',
    ]) {
      const res = await fetch(h.base + attack);
      const text = await res.text();
      expect(text).not.toMatch(/root:.*:0:0:/);
      expect(text).toContain('<!DOCTYPE html>'); // fell back to the app shell
    }
  });

  it('405s a POST to a static path and 404s an unknown API route', async () => {
    const h = await serve([{ text: 'hi' }]);
    const res = await fetch(`${h.base}/styles.css`, { method: 'POST' });
    expect(res.status).toBe(405);

    const nope = await post(h, '/api/does-not-exist');
    expect(nope.status).toBe(404);
    expect(String(nope.data.error)).toMatch(/no such endpoint/);
  });
});

/* ---------------- state & auth ---------------- */

describe('session state', () => {
  it('describes the session at /api/state', async () => {
    const h = await serve([{ text: 'hi' }]);
    const res = await get(h, '/api/state');
    expect(res.status).toBe(200);
    const snap = (await res.json()) as Record<string, unknown>;

    expect(snap.model).toBeTypeOf('string');
    expect(snap.workspace).toBe(h.sbx.dir);
    expect(snap.permissionMode).toBe('auto');
    expect(snap.busy).toBe(false);
    expect(Array.isArray(snap.skills)).toBe(true);
    expect((snap.skills as unknown[]).length).toBeGreaterThan(5);
    expect(Array.isArray(snap.tools)).toBe(true);
    expect(snap.tools as string[]).toContain('remember');
  });

  it('requires the token on /api but not on the static UI', async () => {
    const token = generateToken();
    const h = await serve([{ text: 'hi' }], {}, { token });

    expect((await get(h, '/')).status).toBe(200); // the UI itself is public
    expect((await get(h, '/api/state')).status).toBe(401);
    expect((await get(h, '/api/state', 'wrong')).status).toBe(401);
    expect((await get(h, '/api/state', token)).status).toBe(200);
    expect((await get(h, `/api/state?token=${token}`)).status).toBe(200);

    const res = await get(h, '/api/state');
    const body = (await res.json()) as { error?: string };
    expect(String(body.error)).toMatch(/token/i);
  });

  it('reports provider health at /api/health', async () => {
    const h = await serve([{ text: 'hi' }]);
    const res = await get(h, '/api/health');
    expect(res.status).toBe(200);
    const health = (await res.json()) as Record<string, unknown>;
    expect(health.provider).toBe('mock');
    expect(health.busy).toBe(false);
    expect(Array.isArray(health.models)).toBe(true);
  });
});

/* ---------------- turns over SSE ---------------- */

describe('a turn through the API', () => {
  it('streams deltas, tool cards and turn_end to the browser', async () => {
    const h = await serve(writeTurn);
    const sse = openSse(h);

    const snap = await sse.waitFor('snapshot');
    expect(snap.model).toBeTypeOf('string');

    const chat = await post(h, '/api/chat', { text: 'write the file' });
    expect(chat.status).toBe(202);
    expect(chat.data.accepted).toBe(true);

    const start = await sse.waitFor('tool_start');
    expect(start.name).toBe('write_file');
    const end = await sse.waitFor('tool_end');
    expect(end.ok).toBe(true);
    expect(end.name).toBe('write_file');

    const turn = await sse.waitFor('turn_end', 15_000);
    expect(String(turn.stats)).toMatch(/model/);

    const types = sse.events.map((e) => e.type);
    expect(types).toContain('assistant_delta');
    expect(types).toContain('assistant_end');
    // auto mode never asks, so no approval event may appear
    expect(types).not.toContain('permission_request');
    expect(await readFile(path.join(h.sbx.dir, 'out.txt'), 'utf8')).toBe('hello\n');
  }, 20_000);

  it('rejects an empty message', async () => {
    const h = await serve(writeTurn);
    const res = await post(h, '/api/chat', { text: '   ' });
    expect(res.status).toBe(400);
  });

  it('gives a late-joining client the history it missed', async () => {
    const h = await serve(writeTurn);
    const first = openSse(h);
    await first.waitFor('snapshot');
    await post(h, '/api/chat', { text: 'write the file' });
    await first.waitFor('turn_end', 15_000);
    first.close();

    const second = openSse(h);
    const snap = (await second.waitFor('snapshot')) as {
      history: Array<{ role: string; text: string }>;
      busy: boolean;
    };
    expect(snap.busy).toBe(false);
    expect(snap.history.some((m) => m.role === 'user' && m.text === 'write the file')).toBe(true);
    expect(snap.history.some((m) => m.role === 'assistant')).toBe(true);
  }, 20_000);
});

/* ---------------- sub-agents over SSE ---------------- */

const delegateTurns: MockTurn[] = [
  {
    text: 'Sending a sub-agent to survey the workspace.',
    toolCalls: [
      {
        name: 'task',
        arguments: { prompt: 'Survey this workspace and report what is actually in it.', kind: 'explore' },
      },
    ],
  },
  // these two belong to the CHILD
  { text: '', toolCalls: [{ name: 'list_dir', arguments: { path: '.' } }] },
  { text: 'Survey: the workspace is empty apart from .agent/.' },
  // back to the parent
  { text: 'All done.' },
];

describe('sub-agents over SSE', () => {
  it('streams the lifecycle, the child tool calls, and only the report into history', async () => {
    const h = await serve(delegateTurns, { permissionMode: 'auto' });
    const sse = openSse(h);
    await sse.waitFor('snapshot');
    await post(h, '/api/chat', { text: 'survey the workspace' });
    await sse.waitFor('turn_end', 20_000);

    const types = sse.events.map((e) => e.type);
    const startAt = types.indexOf('subagent_start');
    const endAt = types.indexOf('subagent_end');
    expect(startAt).toBeGreaterThan(-1);
    expect(endAt).toBeGreaterThan(startAt);

    const start = sse.events[startAt]!.data;
    expect(start.kind).toBe('explore');
    expect(String(start.prompt)).toMatch(/Survey this workspace/);
    // clamped to min(subagentMaxSteps, maxSteps); the test harness runs maxSteps: 8
    expect(Number(start.maxSteps)).toBeGreaterThan(0);
    expect(Number(start.maxSteps)).toBeLessThanOrEqual(12);

    const end = sse.events[endAt]!.data;
    expect(end.ok).toBe(true);
    expect(end.kind).toBe('explore');
    expect(Number(end.steps)).toBeGreaterThan(0);
    expect(Number(end.tokens)).toBeGreaterThan(0);

    // the child's list_dir was relayed between the two lifecycle events
    const nested = types.slice(startAt, endAt);
    expect(nested).toContain('tool_start');
    expect(nested).toContain('tool_end');

    // The report itself rides the task tool's result, which the browser sees as a
    // tool_end preview. History stays user/assistant only — that is deliberate.
    const taskEnd = sse.events.find((e) => e.type === 'tool_end' && e.data.name === 'task');
    expect(taskEnd).toBeTruthy();
    expect(taskEnd!.data.ok).toBe(true);
    expect(String(taskEnd!.data.preview)).toMatch(/sub-agent report · explore/);
    expect(String(taskEnd!.data.preview)).toContain('Survey: the workspace is empty');

    const st = ((await (await get(h, '/api/state')).json()) as {
      history: Array<{ role: string; text: string }>;
    }).history;
    const joined = st.map((m) => m.text).join('\n');
    expect(joined).toContain('Sending a sub-agent to survey the workspace.');
    expect(joined).toContain('All done.');
    // the child's raw listing never enters the conversation transcript
    expect(joined).not.toContain('Survey: the workspace is empty');
    sse.close();
  }, 25_000);
});

/* ---------------- the permission gate over HTTP ---------------- */

describe('permissions through the browser', () => {
  it('waits for an approval, then writes the file', async () => {
    const h = await serve(writeTurn, { permissionMode: 'ask' }, { permissionTimeoutMs: 15_000 });
    const sse = openSse(h);
    await sse.waitFor('snapshot');

    await post(h, '/api/chat', { text: 'write the file' });
    const req = (await sse.waitFor('permission_request', 15_000)) as {
      id: string;
      tool: string;
      risk: string;
      path?: string;
    };
    expect(req.tool).toBe('write_file');
    expect(req.risk).toBe('medium');

    // Nothing on disk yet: the loop is parked inside the gate.
    await expect(readFile(path.join(h.sbx.dir, 'out.txt'), 'utf8')).rejects.toThrow();

    const answered = await post(h, '/api/permission', { id: req.id, answer: 'yes' });
    expect(answered.status).toBe(200);
    await sse.waitFor('permission_response');
    await sse.waitFor('turn_end', 15_000);

    expect(await readFile(path.join(h.sbx.dir, 'out.txt'), 'utf8')).toBe('hello\n');
  }, 25_000);

  it('leaves the disk untouched when the browser denies', async () => {
    const h = await serve(writeTurn, { permissionMode: 'ask' }, { permissionTimeoutMs: 15_000 });
    const sse = openSse(h);
    await sse.waitFor('snapshot');

    await post(h, '/api/chat', { text: 'write the file' });
    const req = (await sse.waitFor('permission_request', 15_000)) as { id: string };
    await post(h, '/api/permission', { id: req.id, answer: 'no' });
    await sse.waitFor('turn_end', 15_000);

    await expect(readFile(path.join(h.sbx.dir, 'out.txt'), 'utf8')).rejects.toThrow();
  }, 25_000);

  it('denies by itself when the request expires unanswered', async () => {
    const h = await serve(writeTurn, { permissionMode: 'ask' }, { permissionTimeoutMs: 200 });
    const sse = openSse(h);
    await sse.waitFor('snapshot');

    await post(h, '/api/chat', { text: 'write the file' });
    await sse.waitFor('permission_request', 5_000);
    await sse.waitFor('turn_end', 15_000);

    await expect(readFile(path.join(h.sbx.dir, 'out.txt'), 'utf8')).rejects.toThrow();
  }, 25_000);

  it('validates the answer it is given', async () => {
    const h = await serve(writeTurn, { permissionMode: 'ask' });
    const bad = await post(h, '/api/permission', { id: 'whatever', answer: 'maybe' });
    expect(bad.status).toBe(400);
    const unknown = await post(h, '/api/permission', { id: 'whatever', answer: 'yes' });
    expect(unknown.status).toBe(404);
  });

  it('switches permission mode and says so', async () => {
    const h = await serve([{ text: 'hi' }]);
    const sse = openSse(h);
    await sse.waitFor('snapshot');

    expect((await post(h, '/api/permissions', { mode: 'readonly' })).status).toBe(200);
    expect((await post(h, '/api/permissions', { mode: 'yolo' })).status).toBe(400);

    const note = await sse.waitFor('note');
    expect(String(note.text)).toMatch(/readonly/);
    const snap = await (await get(h, '/api/state')).json();
    expect((snap as { permissionMode: string }).permissionMode).toBe('readonly');
  });
});

/* ---------------- controls ---------------- */

describe('session controls', () => {
  it('loads a skill, and 404s on one that does not exist', async () => {
    const h = await serve([{ text: 'hi' }]);
    const res = await post(h, '/api/skill', { name: 'design' });
    expect(res.status).toBe(200);
    expect(res.data.loaded).toBe('design');
    expect(h.rt.skills.isLoaded('design')).toBe(true);

    // loading twice is a no-op, not an error
    expect((await post(h, '/api/skill', { name: 'design' })).data.alreadyLoaded).toBe(true);

    const missing = await post(h, '/api/skill', { name: 'not-a-skill' });
    expect(missing.status).toBe(404);
    expect(missing.data.available).toBeDefined();
  });

  it('switches model', async () => {
    const h = await serve([{ text: 'hi' }]);
    expect((await post(h, '/api/model', { model: 'qwen3:8b' })).status).toBe(200);
    expect(h.rt.config.model).toBe('qwen3:8b');
    expect((await post(h, '/api/model', { model: '' })).status).toBe(400);
  });

  it('clears and undoes history', async () => {
    const h = await serve([{ text: 'answer one' }]);
    const sse = openSse(h);
    await sse.waitFor('snapshot');
    await post(h, '/api/chat', { text: 'first message' });
    await sse.waitFor('turn_end', 15_000);

    const before = ((await (await get(h, '/api/state')).json()) as { history: unknown[] }).history
      .length;
    expect(before).toBeGreaterThan(0);

    expect((await post(h, '/api/undo', {})).status).toBe(200);
    const mid = ((await (await get(h, '/api/state')).json()) as { history: unknown[] }).history.length;
    expect(mid).toBeLessThan(before);

    expect((await post(h, '/api/clear', {})).status).toBe(200);
    const after = ((await (await get(h, '/api/state')).json()) as { history: unknown[] }).history.length;
    expect(after).toBe(0);
  }, 20_000);

  it('interrupts a running turn', async () => {
    const h = await serve([{ text: 'hi' }]);
    // Nothing is running, so there is nothing to interrupt.
    const res = await post(h, '/api/interrupt', {});
    expect(res.status).toBe(200);
    expect(res.data.interrupted).toBe(false);
  });
});

/* ---------------- memory over HTTP ---------------- */

describe('memory through the API', () => {
  it('adds, lists, votes on and forgets', async () => {
    const h = await serve([{ text: 'hi' }]);

    const added = await post(h, '/api/memory', { text: 'Use pnpm, never npm', tags: ['tooling'] });
    expect(added.status).toBe(200);
    const lesson = added.data.lesson as { id: string; score: number };
    expect(lesson.id).toMatch(/^l_/);

    const listed = await (await get(h, '/api/memory')).json();
    expect((listed as { count: number }).count).toBe(1);

    const voted = await post(h, '/api/memory/vote', { id: lesson.id, delta: 1 });
    expect(((voted.data.lesson as { score: number }).score)).toBe(lesson.score + 1);

    const badVote = await post(h, '/api/memory/vote', { id: lesson.id, delta: 5 });
    expect(badVote.status).toBe(400);

    const deleted = await del(h, `/api/memory/${lesson.id}`);
    expect(deleted.status).toBe(200);
    expect((await (await get(h, '/api/memory')).json()) as { count: number }).toMatchObject({
      count: 0,
    });
  });

  it('refuses to write memory when memory is disabled', async () => {
    const h = await serve([{ text: 'hi' }], { memoryEnabled: false });
    const res = await post(h, '/api/memory', { text: 'anything' });
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toMatch(/disabled/i);
  });

  it('records 👍/👎 feedback as a vote or a correction', async () => {
    const h = await serve([{ text: 'hi' }]);

    const up = await post(h, '/api/feedback', { verdict: 'up' });
    expect(up.status).toBe(200);

    const down = await post(h, '/api/feedback', {
      verdict: 'down',
      note: 'Prefer named exports over default exports',
    });
    expect(down.status).toBe(200);
    expect((down.data.lesson as { source: string }).source).toBe('feedback');

    const bad = await post(h, '/api/feedback', { verdict: 'sideways' });
    expect(bad.status).toBe(400);
  });
});

/* ---------------- checkpoints over HTTP ---------------- */

describe('checkpoints through the API', () => {
  it('appears in the snapshot and streams a checkpoint event when a turn writes', async () => {
    const h = await serve(writeTurn);
    const sse = openSse(h);

    const snap = (await sse.waitFor('snapshot')) as {
      checkpoints: { count: number; items: unknown[] };
    };
    expect(snap.checkpoints.count).toBe(0);
    expect(snap.checkpoints.items).toEqual([]);

    await post(h, '/api/chat', { text: 'write the file' });
    const cp = (await sse.waitFor('checkpoint', 15_000)) as {
      id: string;
      label: string;
      files: string[];
    };
    expect(cp.files).toEqual(['out.txt']);
    expect(cp.label).toBe('write the file');

    const listed = (await (await get(h, '/api/checkpoints')).json()) as {
      count: number;
      root: string;
      checkpoints: Array<{ id: string; files: Array<{ rel: string; existed: boolean; bytes: number }> }>;
    };
    expect(listed.count).toBe(1);
    expect(listed.root).toContain('checkpoints');
    // existed:false + 0 bytes = the agent created this file, so restoring deletes it
    expect(listed.checkpoints[0]!.files[0]).toEqual({ rel: 'out.txt', existed: false, bytes: 0 });
  }, 20_000);

  it('rolls the workspace back, and the rollback is itself reversible', async () => {
    const h = await serve(writeTurn);
    const sse = openSse(h);
    await sse.waitFor('snapshot');

    await post(h, '/api/chat', { text: 'write the file' });
    await sse.waitFor('turn_end', 15_000);
    const file = path.join(h.sbx.dir, 'out.txt');
    expect(await readFile(file, 'utf8')).toBe('hello\n');

    // no id = "undo the last thing you did"
    const res = await post(h, '/api/restore', {});
    expect(res.status).toBe(200);
    expect(res.data.deleted).toEqual(['out.txt']);
    expect(res.data.undoId).toBeTypeOf('string');
    await expect(readFile(file, 'utf8')).rejects.toThrow();

    // ...and undoing the undo brings it back
    const again = await post(h, '/api/restore', { id: String(res.data.undoId) });
    expect(again.status).toBe(200);
    expect(again.data.reverted).toEqual(['out.txt']);
    expect(await readFile(file, 'utf8')).toBe('hello\n');
  }, 20_000);

  it('accepts an id prefix and rejects one that does not exist', async () => {
    const h = await serve(writeTurn);
    const sse = openSse(h);
    await sse.waitFor('snapshot');
    await post(h, '/api/chat', { text: 'write the file' });
    const cp = (await sse.waitFor('checkpoint', 15_000)) as { id: string };

    const prefixed = await post(h, '/api/restore', { id: cp.id.slice(0, 8) });
    expect(prefixed.status).toBe(200);

    const missing = await post(h, '/api/restore', { id: 'cp_doesnotexist' });
    expect(missing.status).toBe(404);
    expect(missing.data.available).toBeDefined();
  }, 20_000);

  it('404s when nothing has been checkpointed yet', async () => {
    const h = await serve([{ text: 'just talking' }]);
    const res = await post(h, '/api/restore', {});
    expect(res.status).toBe(404);
    expect(String(res.data.error)).toMatch(/no checkpoints/i);
  });

  it('400s when checkpointing is switched off', async () => {
    const h = await serve(writeTurn, { checkpointsEnabled: false });
    const list = await (await get(h, '/api/checkpoints')).json();
    expect((list as { count: number }).count).toBe(0);
    expect((list as { root: string | null }).root).toBeNull();

    const res = await post(h, '/api/restore', {});
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toMatch(/disabled/i);
  });

  it('clears every checkpoint on request', async () => {
    const h = await serve(writeTurn);
    const sse = openSse(h);
    await sse.waitFor('snapshot');
    await post(h, '/api/chat', { text: 'write the file' });
    await sse.waitFor('checkpoint', 15_000);

    const cleared = await post(h, '/api/checkpoints/clear', {});
    expect(cleared.status).toBe(200);
    expect(cleared.data.removed).toBe(1);

    const after = (await (await get(h, '/api/checkpoints')).json()) as { count: number };
    expect(after.count).toBe(0);
  }, 20_000);
});
