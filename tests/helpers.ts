import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, type AgentConfig, type PermissionMode } from '../src/config.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { MockProvider, type MockTurn } from '../src/llm/mock.js';
import { UI } from '../src/ui/ui.js';
import type { ToolContext } from '../src/tools/types.js';
import { PermissionGate } from '../src/safety/permissions.js';
import { LessonStore } from '../src/memory/lessons.js';
import { newSession } from '../src/util/session.js';

export interface Sandbox {
  dir: string;
  cleanup(): Promise<void>;
  write(rel: string, content: string): Promise<string>;
  read(rel: string): Promise<string>;
  exists(rel: string): Promise<boolean>;
}

export async function makeSandbox(): Promise<Sandbox> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lca-test-'));
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
    async write(rel, content) {
      const abs = path.join(dir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      return abs;
    },
    async read(rel) {
      const { readFile } = await import('node:fs/promises');
      return readFile(path.join(dir, rel), 'utf8');
    },
    async exists(rel) {
      const { stat } = await import('node:fs/promises');
      return stat(path.join(dir, rel)).then(
        () => true,
        () => false,
      );
    },
  };
}

export function testConfig(dir: string, over: Partial<AgentConfig> = {}): AgentConfig {
  return resolveConfig({
    workspace: dir,
    provider: 'mock',
    permissionMode: 'auto' as PermissionMode,
    maxSteps: 8,
    numCtx: 4096,
    ...over,
  });
}

/** A UI that throws output away, so tests stay readable. */
export function silentUI(): UI {
  return new UI({ quiet: true, verbose: false, interactive: false, write: () => {} });
}

export async function makeContext(
  dir: string,
  over: Partial<AgentConfig> = {},
): Promise<{ ctx: ToolContext; cleanup: () => Promise<void> }> {
  const cfg = testConfig(dir, over);
  const session = newSession(cfg);
  const ui = silentUI();
  const permissions = new PermissionGate(cfg.permissionMode, session, ui);
  const memory = cfg.memoryEnabled ? await LessonStore.open(cfg.stateDir) : null;
  return {
    ctx: {
      workspace: cfg.workspace,
      config: cfg,
      permissions,
      session,
      ui,
      signal: new AbortController().signal,
      skills: null,
      memory,
      checkpoint: null,
    },
    cleanup: async () => {},
  };
}

export async function makeRuntime(
  dir: string,
  turns: MockTurn[],
  over: Partial<AgentConfig> = {},
): Promise<{ rt: AgentRuntime; ui: UI }> {
  const cfg = testConfig(dir, over);
  const ui = silentUI();
  const rt = await AgentRuntime.create({
    ui,
    config: cfg,
    provider: new MockProvider(turns),
    factory: () => new MockProvider(turns),
  });
  return { rt, ui };
}
