import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AgentRuntime } from '../agent/runtime.js';
import { pingOllama } from '../llm/ollama.js';
import type { Answer } from '../ui/ui.js';
import { WebPrompter } from './web-prompter.js';
import { WebSession } from './session.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED_WEB_DIR = path.resolve(here, '..', '..', 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface ServeOptions {
  host: string;
  port: number;
  webDir: string;
  /** Shared secret. Required for every /api/* call when set. */
  token?: string;
  permissionTimeoutMs?: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit = 2_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Serve a static file, jailed inside webDir. */
function serveStatic(webDir: string, urlPath: string, res: ServerResponse): void {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.resolve(webDir, rel);
  const root = path.resolve(webDir);

  if (abs !== root && !abs.startsWith(root + path.sep)) {
    text(res, 403, 'Forbidden');
    return;
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    // Single-page behaviour: unknown paths fall back to the app shell.
    const fallback = path.join(root, 'index.html');
    if (existsSync(fallback) && !rel.startsWith('api/')) {
      serveStatic(webDir, '/index.html', res);
      return;
    }
    text(res, 404, 'Not found');
    return;
  }

  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': statSync(abs).size,
    'Cache-Control': 'no-cache',
  });
  createReadStream(abs).pipe(res);
}

export interface StartedServer {
  server: Server;
  session: WebSession;
  /** The port actually bound (useful when the caller passed 0). */
  port: number;
  url: string;
  token?: string;
  close(): Promise<void>;
}

/**
 * The HTTP + SSE layer. Built on node:http with no framework: the project's rule
 * is zero runtime dependencies, and a chat server needs about 200 lines.
 */
export async function startServer(
  rt: AgentRuntime,
  opts: ServeOptions,
): Promise<StartedServer> {
  const prompter = new WebPrompter(rt.ui, {
    timeoutMs: opts.permissionTimeoutMs,
    // In "auto" mode nothing ever prompts, so the default only matters for ask/readonly.
    defaultAnswer: rt.config.permissionMode === 'auto' ? 'yes' : 'no',
  });

  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(opts.host);
  const authRequired = Boolean(opts.token);
  const session = new WebSession(rt, prompter, { authRequired });

  if (!loopback && !authRequired) {
    rt.ui.warn(
      `serving on ${opts.host} with NO token — anyone on this network can run shell commands as you.`,
    );
    rt.ui.warn('bind to 127.0.0.1, or set LCA_WEB_TOKEN, unless you know the network is trusted.');
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    // Permissive CORS only for the sandbox preview / local tools; the token is
    // still required for anything that mutates.
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-LCA-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      /* ---------------- API auth ---------------- */
      if (url.pathname.startsWith('/api/')) {
        if (authRequired) {
          const supplied =
            url.searchParams.get('token') ??
            (req.headers['x-lca-token'] as string | undefined) ??
            (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
          // Constant-time-ish compare; the token is a session secret, not a password hash.
          if (supplied !== opts.token) {
            json(res, 401, { error: 'Missing or wrong token. Append ?token=... to the URL.' });
            return;
          }
        }

        /* ---------------- event stream ---------------- */
        if (url.pathname === '/api/events' && method === 'GET') {
          const unsubscribe = session.subscribe(res);
          req.on('close', unsubscribe);
          req.on('error', unsubscribe);
          return; // keep the response open
        }

        /* ---------------- read-only state ---------------- */
        if (url.pathname === '/api/state' && method === 'GET') {
          json(res, 200, session.snapshot());
          return;
        }

        if (url.pathname === '/api/health' && method === 'GET') {
          const ping = await pingOllama(rt.config.ollamaUrl);
          json(res, 200, {
            ok: ping.ok,
            provider: rt.config.provider,
            model: rt.config.model,
            busy: session.isBusy,
            clients: session.clientCount,
            ollamaUrl: rt.config.ollamaUrl,
            models: ping.models ?? [],
            error: ping.error,
          });
          return;
        }

        if (url.pathname === '/api/memory' && method === 'GET') {
          json(res, 200, {
            count: rt.memory?.count ?? 0,
            path: rt.memory?.path ?? null,
            lessons: (rt.memory?.all() ?? []).slice().reverse(),
          });
          return;
        }

        /* ---------------- actions ---------------- */
        if (url.pathname === '/api/chat' && method === 'POST') {
          const body = await readBody(req);
          const text = String(body.text ?? '').trim();
          if (!text) {
            json(res, 400, { error: 'text is required' });
            return;
          }
          if (text.length > 100_000) {
            json(res, 413, { error: 'message too long' });
            return;
          }
          const skill = body.skill ? String(body.skill) : undefined;
          const queue = body.queue === true;
          // Respond immediately; the work streams over SSE.
          json(res, 202, { accepted: true, busy: session.isBusy });
          void session.send(text, { ...(skill ? { skill } : {}), queue });
          return;
        }

        if (url.pathname === '/api/interrupt' && method === 'POST') {
          json(res, 200, { interrupted: session.interrupt() });
          return;
        }

        if (url.pathname === '/api/permission' && method === 'POST') {
          const body = await readBody(req);
          const id = String(body.id ?? '');
          const answer = String(body.answer ?? '') as Answer;
          if (!['yes', 'no', 'always'].includes(answer)) {
            json(res, 400, { error: 'answer must be yes, no or always' });
            return;
          }
          const resolved = prompter.answer(id, answer);
          json(res, resolved ? 200 : 404, resolved ? { ok: true } : { error: 'unknown or expired request id' });
          return;
        }

        if (url.pathname === '/api/permissions' && method === 'POST') {
          const body = await readBody(req);
          const mode = String(body.mode ?? '');
          if (!['ask', 'auto', 'readonly'].includes(mode)) {
            json(res, 400, { error: 'mode must be ask, auto or readonly' });
            return;
          }
          rt.setPermissionMode(mode as 'ask' | 'auto' | 'readonly');
          await rt.refreshContext();
          session.broadcast({ type: 'note', text: `permission mode is now ${mode}` });
          json(res, 200, { mode });
          return;
        }

        if (url.pathname === '/api/model' && method === 'POST') {
          const body = await readBody(req);
          const model = String(body.model ?? '').trim();
          if (!model) {
            json(res, 400, { error: 'model is required' });
            return;
          }
          rt.setModel(model);
          await rt.refreshContext();
          session.broadcast({ type: 'note', text: `model is now ${model}` });
          json(res, 200, { model });
          return;
        }

        if (url.pathname === '/api/skill' && method === 'POST') {
          const body = await readBody(req);
          const name = String(body.name ?? '').trim();
          if (!rt.skills.get(name)) {
            json(res, 404, { error: `no skill called "${name}"`, available: rt.skills.all().map((s) => s.name) });
            return;
          }
          if (rt.skills.isLoaded(name)) {
            json(res, 200, { loaded: name, alreadyLoaded: true });
            return;
          }
          const okLoad = rt.preloadSkill(name);
          if (okLoad) rt.ui.emitSkill(name);
          json(res, 200, { loaded: okLoad ? name : null });
          return;
        }

        if (url.pathname === '/api/clear' && method === 'POST') {
          rt.clearHistory();
          session.broadcast({ type: 'note', text: 'history cleared' });
          json(res, 200, { ok: true });
          return;
        }

        if (url.pathname === '/api/undo' && method === 'POST') {
          json(res, 200, { ok: rt.undoLast() });
          return;
        }

        if (url.pathname === '/api/compact' && method === 'POST') {
          json(res, 200, rt.compactNow());
          return;
        }

        if (url.pathname === '/api/memory' && method === 'POST') {
          const body = await readBody(req);
          const text = String(body.text ?? '').trim();
          if (!rt.memory) {
            json(res, 400, { error: 'memory is disabled (LCA_MEMORY=false)' });
            return;
          }
          if (!text) {
            json(res, 400, { error: 'text is required' });
            return;
          }
          const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
          const lesson = await rt.memory.add(text, { tags, source: 'user' });
          session.broadcast({ type: 'note', text: `remembered: ${lesson.text}` });
          json(res, 200, { lesson });
          return;
        }

        if (url.pathname === '/api/memory/vote' && method === 'POST') {
          const body = await readBody(req);
          const id = String(body.id ?? '');
          const delta = Number(body.delta ?? 0);
          if (!rt.memory || !id || ![-1, 1].includes(delta)) {
            json(res, 400, { error: 'need id and delta of 1 or -1' });
            return;
          }
          const lesson = await rt.memory.vote(id, delta);
          json(res, lesson ? 200 : 404, lesson ? { lesson } : { error: 'unknown id' });
          return;
        }

        if (url.pathname.startsWith('/api/memory/') && method === 'DELETE') {
          const id = url.pathname.slice('/api/memory/'.length);
          if (!rt.memory) {
            json(res, 400, { error: 'memory is disabled' });
            return;
          }
          json(res, (await rt.memory.remove(id)) ? 200 : 404, { ok: true });
          return;
        }

        if (url.pathname === '/api/feedback' && method === 'POST') {
          const body = await readBody(req);
          const verdict = String(body.verdict ?? '');
          const note = String(body.note ?? '').trim();
          if (!rt.memory) {
            json(res, 400, { error: 'memory is disabled' });
            return;
          }
          if (verdict === 'up') {
            // Reward whatever was recalled for this turn, so good memories surface more.
            let voted = 0;
            for (const id of rt.lastInjectedLessons) {
              if (await rt.memory.vote(id, 1)) voted += 1;
            }
            json(res, 200, { ok: true, voted });
            return;
          }
          if (verdict === 'down') {
            for (const id of rt.lastInjectedLessons) await rt.memory.vote(id, -1);
            if (note) {
              const lesson = await rt.memory.add(note, { tags: ['correction'], source: 'feedback' });
              session.broadcast({ type: 'note', text: `remembered correction: ${lesson.text}` });
              json(res, 200, { ok: true, lesson });
              return;
            }
            json(res, 200, { ok: true, penalised: rt.lastInjectedLessons.length });
            return;
          }
          json(res, 400, { error: 'verdict must be "up" or "down"' });
          return;
        }

        json(res, 404, { error: `no such endpoint: ${method} ${url.pathname}` });
        return;
      }

      /* ---------------- static web UI ---------------- */
      if (method !== 'GET' && method !== 'HEAD') {
        text(res, 405, 'Method not allowed');
        return;
      }
      if (!existsSync(opts.webDir)) {
        text(res, 500, `web UI folder not found: ${opts.webDir}`);
        return;
      }
      serveStatic(opts.webDir, url.pathname, res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) json(res, 500, { error: msg });
      else res.end();
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  // Read back the port we actually got: `--port 0` means "any free port".
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : opts.port;
  const shownHost = ['0.0.0.0', '::'].includes(opts.host) ? '127.0.0.1' : opts.host;
  const url = `http://${shownHost}:${boundPort}/`;

  return {
    server,
    session,
    port: boundPort,
    url,
    ...(opts.token ? { token: opts.token } : {}),
    async close() {
      session.close();
      // server.close() alone waits for keep-alive sockets to time out, which
      // makes Ctrl+C hang for seconds. Drop them explicitly.
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function generateToken(): string {
  return randomBytes(18).toString('base64url');
}

export async function readWebDirDefault(): Promise<string> {
  return BUNDLED_WEB_DIR;
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p, 'utf8');
    return true;
  } catch {
    return false;
  }
}
