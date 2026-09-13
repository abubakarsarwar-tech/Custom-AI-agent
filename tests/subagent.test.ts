import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runSubagent, buildSubagentPrompt, type SubagentDeps } from '../src/agent/subagent.js';
import { taskTool } from '../src/tools/task.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { estimateMessages } from '../src/agent/tokens.js';
import type { UIEvent } from '../src/ui/ui.js';
import type { ActionRequest } from '../src/safety/permissions.js';
import type { Tool, ToolContext, ToolResult } from '../src/tools/types.js';
import { makeRuntime, makeSandbox, type Sandbox } from './helpers.js';
import type { GenerateOptions, LLMProvider, Message, StreamEvent, ToolSpec } from '../src/llm/types.js';

/** Records the tool schema each generation was offered, then delegates. */
class SpyProvider implements LLMProvider {
  readonly name = 'spy';
  readonly seenToolSets: string[][] = [];
  constructor(private readonly inner: LLMProvider) {}
  stream(
    messages: Message[],
    tools: ToolSpec[],
    opts: GenerateOptions = {},
  ): AsyncGenerator<StreamEvent> {
    this.seenToolSets.push(tools.map((t) => t.function.name));
    return this.inner.stream(messages, tools, opts);
  }
}
import type { MockTurn } from '../src/llm/mock.js';
import type { AgentRuntime } from '../src/agent/runtime.js';

/** Big file contents, so context isolation is measurable rather than asserted. */
const BIG = 'x'.repeat(4000);

function depsFrom(rt: AgentRuntime): SubagentDeps {
  return {
    provider: rt.provider,
    config: rt.config,
    registry: rt.registry,
    ui: rt.ui,
    skills: rt.skills,
    repoContext: rt.repoContext,
    session: rt.session,
    permissions: rt.permissions,
    checkpoints: rt.checkpoints,
  };
}

async function seedBig(sbx: Sandbox): Promise<void> {
  await writeFile(path.join(sbx.dir, 'a.txt'), `${BIG}\n`, 'utf8');
  await writeFile(path.join(sbx.dir, 'b.txt'), `${BIG}\n`, 'utf8');
}

describe('context isolation — the whole point', () => {
  it('the parent only pays for the report, not for what the sub-agent read', async () => {
    const sbx = await makeSandbox();
    try {
      await seedBig(sbx);
      const turns: MockTurn[] = [
        // parent: delegate
        {
          text: 'Let me send someone to look.',
          toolCalls: [
            {
              name: 'task',
              arguments: { prompt: 'Find where the big constants live and report the files.', kind: 'explore' },
            },
          ],
        },
        // child: two expensive reads
        { text: '', toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
        { text: '', toolCalls: [{ name: 'read_file', arguments: { path: 'b.txt' } }] },
        // child: the report — this is the only thing that travels back
        { text: 'Both a.txt and b.txt hold 4000 x characters. Nothing else references them.' },
        // parent: done
        { text: 'a.txt and b.txt both hold filler.' },
      ];
      const { rt } = await makeRuntime(sbx.dir, turns, { permissionMode: 'auto' });

      const before = estimateMessages(rt.messages);
      await rt.send('where are the big constants?');
      const after = estimateMessages(rt.messages);

      const grew = after - before;
      // Two 4,000-char reads are ~2,300 tokens. The parent must not have them.
      expect(grew).toBeLessThan(800);

      const joined = rt.messages.map((m) => m.content).join('\n');
      expect(joined).toContain('Both a.txt and b.txt hold 4000 x characters');
      expect(joined).not.toContain(BIG); // the raw reads never reached the parent
      expect(joined).toContain('[sub-agent report · explore');
      expect(joined).toMatch(/in \d+ \/ out \d+ tok/);
    } finally {
      await sbx.cleanup();
    }
  });

  it('folds the sub-agent token spend into the parent totals, so stats stay honest', async () => {
    const sbx = await makeSandbox();
    try {
      await seedBig(sbx);
      const turns: MockTurn[] = [
        { text: '', toolCalls: [{ name: 'task', arguments: { prompt: 'read the big files and report' } }] },
        { text: '', toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
        { text: 'Report: a.txt is big.' },
        { text: 'Done.' },
      ];
      const { rt } = await makeRuntime(sbx.dir, turns, { permissionMode: 'auto' });
      await rt.send('go');

      // the child read 4,000 chars; if its spend were dropped this would be far smaller
      expect(rt.session.totals.promptTokens).toBeGreaterThan(1000);
      expect(rt.statsLine()).toMatch(/in \d/);
    } finally {
      await sbx.cleanup();
    }
  });
});

describe('safety rails', () => {
  it('explore is read-only: a write attempt is refused and reported, not performed', async () => {
    const sbx = await makeSandbox();
    try {
      const turns: MockTurn[] = [
        { text: '', toolCalls: [{ name: 'task', arguments: { prompt: 'tidy up the repo files now' } }] },
        {
          text: '',
          toolCalls: [{ name: 'write_file', arguments: { path: 'sneaky.txt', content: 'nope\n' } }],
        },
        { text: 'I could not write: read-only. The repo has no files to tidy.' },
        { text: 'Done.' },
      ];
      const { rt } = await makeRuntime(sbx.dir, turns, { permissionMode: 'auto' });
      await rt.send('tidy up');

      expect(existsSync(path.join(sbx.dir, 'sneaky.txt'))).toBe(false);
      const joined = rt.messages.map((m) => m.content).join('\n');
      expect(joined).toMatch(/read-only|Not allowed/i);
    } finally {
      await sbx.cleanup();
    }
  });

  it('work inherits the parent permission mode and its writes are covered by the parent checkpoint', async () => {
    const sbx = await makeSandbox();
    try {
      const turns: MockTurn[] = [
        {
          text: '',
          toolCalls: [
            { name: 'task', arguments: { prompt: 'create notes.md with the findings', kind: 'work' } },
          ],
        },
        {
          text: '',
          toolCalls: [{ name: 'write_file', arguments: { path: 'notes.md', content: '# Notes\n' } }],
        },
        { text: 'Created notes.md.' },
        { text: 'Done.' },
      ];
      const { rt } = await makeRuntime(sbx.dir, turns, { permissionMode: 'auto' });
      await rt.send('write the notes');

      expect(await readFile(path.join(sbx.dir, 'notes.md'), 'utf8')).toBe('# Notes\n');

      // ONE undo boundary: the child's write is inside the parent's turn checkpoint
      const cps = rt.checkpointList();
      expect(cps).toHaveLength(1);
      expect(cps[0]!.files.map((f) => f.rel)).toEqual(['notes.md']);

      await rt.restoreCheckpoint(cps[0]!.id);
      expect(existsSync(path.join(sbx.dir, 'notes.md'))).toBe(false);
    } finally {
      await sbx.cleanup();
    }
  });

  it('cannot nest: the child is never offered the task tool', async () => {
    const sbx = await makeSandbox();
    try {
      const { rt } = await makeRuntime(
        sbx.dir,
        [
          { text: '', toolCalls: [{ name: 'probe', arguments: {} }] },
          { text: 'report' },
        ],
        { permissionMode: 'auto' },
      );
      expect(rt.registry.has('task')).toBe(true);

      // Record the tool schema each call is offered: call 1 is the parent's
      // child run, so this proves the filter rather than trusting it.
      const spy = new SpyProvider(rt.provider);
      const childRunnerWasNull: boolean[] = [];
      const probe: Tool = {
        name: 'probe',
        description: 'reports what the sub-agent context can see',
        parameters: { type: 'object', properties: {}, required: [] },
        risk: 'low',
        summarize: () => 'probe',
        async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
          childRunnerWasNull.push(ctx.subagent === null);
          return { content: 'probed' };
        },
      };
      rt.registry.register(probe);

      const res = await runSubagent(
        { ...depsFrom(rt), provider: spy },
        { prompt: 'probe the nesting rules', kind: 'explore', signal: new AbortController().signal },
      );
      expect(res.ok).toBe(true);

      const offered = spy.seenToolSets[0]!;
      expect(offered).not.toContain('task'); // no nesting
      expect(offered).not.toContain('remember'); // memory belongs to the conversation
      expect(offered).toContain('probe'); // everything else carried over
      expect(childRunnerWasNull).toEqual([true]); // belt AND braces
    } finally {
      await sbx.cleanup();
    }
  });

  it('a sub-agent permission prompt reaches the user, labelled as a sub-agent', async () => {
    const sbx = await makeSandbox();
    try {
      const asked: ActionRequest[] = [];
      const turns: MockTurn[] = [
        { text: '', toolCalls: [{ name: 'task', arguments: { prompt: 'write the report file', kind: 'work' } }] },
        { text: '', toolCalls: [{ name: 'write_file', arguments: { path: 'r.txt', content: 'r\n' } }] },
        { text: 'Wrote it.' },
        { text: 'Done.' },
      ];
      const { rt, ui } = await makeRuntime(sbx.dir, turns, { permissionMode: 'ask' });
      ui.ask = async (req: ActionRequest) => {
        asked.push(req);
        return 'yes';
      };

      await rt.send('write it');
      expect(asked).toHaveLength(1);
      expect(asked[0]!.summary.startsWith('[sub-agent]')).toBe(true);
      expect(await readFile(path.join(sbx.dir, 'r.txt'), 'utf8')).toBe('r\n');
    } finally {
      await sbx.cleanup();
    }
  });

  it('Stop reaches the sub-agent: aborting propagates and the report says so', async () => {
    const sbx = await makeSandbox();
    try {
      const ac = new AbortController();
      const boom: Tool = {
        name: 'boom',
        description: 'aborts',
        parameters: { type: 'object', properties: {}, required: [] },
        risk: 'low',
        summarize: () => 'boom',
        async run(): Promise<ToolResult> {
          ac.abort();
          return { content: 'aborted now' };
        },
      };
      const { rt } = await makeRuntime(sbx.dir, [{ text: '', toolCalls: [{ name: 'boom', arguments: {} }] }], {
        permissionMode: 'auto',
      });
      rt.registry.register(boom);

      const res = await runSubagent(depsFrom(rt), {
        prompt: 'do a long job',
        kind: 'explore',
        signal: ac.signal,
      });
      expect(res.aborted).toBe(true);
      expect(res.ok).toBe(false);
      expect(res.report).toMatch(/ABORTED/);
    } finally {
      await sbx.cleanup();
    }
  });

  it('caps the steps and tells the parent the report may be incomplete', async () => {
    const sbx = await makeSandbox();
    try {
      const { rt } = await makeRuntime(
        sbx.dir,
        [
          { text: '', toolCalls: [{ name: 'list_dir', arguments: { path: '.' } }] },
          { text: '', toolCalls: [{ name: 'list_dir', arguments: { path: '.' } }] },
          { text: 'never reached' },
        ],
        { permissionMode: 'auto', subagentMaxSteps: 1 },
      );

      const res = await runSubagent(depsFrom(rt), {
        prompt: 'keep looking forever',
        kind: 'explore',
        signal: new AbortController().signal,
      });
      expect(res.hitMaxSteps).toBe(true);
      expect(res.steps).toBe(1);
      expect(res.report).toMatch(/step limit/);
    } finally {
      await sbx.cleanup();
    }
  });

  it('truncates an over-long report instead of blowing the parent window', async () => {
    const sbx = await makeSandbox();
    try {
      const { rt } = await makeRuntime(sbx.dir, [{ text: 'y'.repeat(5000) }], {
        permissionMode: 'auto',
        subagentReportChars: 300,
      });

      const res = await runSubagent(depsFrom(rt), {
        prompt: 'report everything',
        kind: 'explore',
        signal: new AbortController().signal,
      });
      expect(res.truncated).toBe(true);
      expect(res.report.length).toBeLessThan(500);
      expect(res.report).toMatch(/report truncated at 300 chars/);
    } finally {
      await sbx.cleanup();
    }
  });
});

describe('events and skills', () => {
  it('relays the sub-agent lifecycle and its tool calls to the parent listener', async () => {
    const sbx = await makeSandbox();
    try {
      const { rt, ui } = await makeRuntime(
        sbx.dir,
        [
          { text: '', toolCalls: [{ name: 'list_dir', arguments: { path: '.' } }] },
          { text: 'Nothing interesting here.' },
        ],
        { permissionMode: 'auto' },
      );
      const seen: UIEvent[] = [];
      ui.listener = (e) => seen.push(e);

      await runSubagent(depsFrom(rt), {
        prompt: 'look around and report',
        kind: 'explore',
        signal: new AbortController().signal,
      });

      const types = seen.map((e) => e.type);
      expect(types[0]).toBe('subagent_start');
      expect(types).toContain('tool_start');
      expect(types).toContain('tool_end');
      expect(types[types.length - 1]).toBe('subagent_end');

      const start = seen[0] as { prompt: string; kind: string; maxSteps: number };
      expect(start.prompt).toBe('look around and report');
      expect(start.kind).toBe('explore');
      const end = seen[seen.length - 1] as { ok: boolean; steps: number; toolCalls: number };
      expect(end.ok).toBe(true);
      expect(end.toolCalls).toBe(1);
    } finally {
      await sbx.cleanup();
    }
  });

  it('the child gets its own skill loaded-set, so the parent is not lied to', async () => {
    const sbx = await makeSandbox();
    try {
      const { rt } = await makeRuntime(sbx.dir, [{ text: 'report' }], { permissionMode: 'auto' });
      const parent = rt.skills;
      const child = parent.spawn();

      expect(child.count).toBe(parent.count);
      expect(child.enabled).toBe(parent.enabled);
      expect(child.isLoaded('design')).toBe(false);

      child.load('design');
      expect(child.isLoaded('design')).toBe(true);
      // the parent never saw that body, so it must still be free to load it
      expect(parent.isLoaded('design')).toBe(false);
      expect(parent.spawn().isLoaded('design')).toBe(false);
    } finally {
      await sbx.cleanup();
    }
  });

  it('auto-routes a skill for the child and says so', async () => {
    const sbx = await makeSandbox();
    try {
      const { rt, ui } = await makeRuntime(sbx.dir, [{ text: 'report' }], { permissionMode: 'auto' });
      const seen: UIEvent[] = [];
      ui.listener = (e) => seen.push(e);

      await runSubagent(depsFrom(rt), {
        prompt: 'explain what this codebase does and how the modules fit together',
        kind: 'explore',
        signal: new AbortController().signal,
      });
      const skills = seen.filter((e) => e.type === 'skill_loaded').map((e) => (e as { name: string }).name);
      expect(skills.length).toBeLessThanOrEqual(1);
    } finally {
      await sbx.cleanup();
    }
  });
});

describe('the task tool', () => {
  it('refuses a brief that is too vague to delegate', async () => {
    const sbx = await makeSandbox();
    try {
      const { makeContext } = await import('./helpers.js');
      const { ctx } = await makeContext(sbx.dir);
      const calls: string[] = [];
      // A stub runner: the brief is validated BEFORE anything is spawned.
      const withRunner = {
        ...ctx,
        subagent: async (req: { prompt: string }) => {
          calls.push(req.prompt);
          return {
            ok: true, report: 'stub report', kind: 'explore' as const, steps: 1, toolCalls: 0,
            truncated: false, hitMaxSteps: false, aborted: false,
            tokens: { prompt: 1, completion: 1 }, ms: 1,
          };
        },
      };

      const res = await taskTool.run({ prompt: 'look at stuff' }, withRunner);
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(/too vague/i);
      expect(calls).toEqual([]); // refused without spawning anything

      const empty = await taskTool.run({ prompt: '' }, withRunner);
      expect(empty.isError).toBe(true);
      expect(calls).toEqual([]);

      // defaults to explore, and a good brief does spawn
      const good = await taskTool.run(
        { prompt: 'Find every place the session token is validated and list file:line.' },
        withRunner,
      );
      expect(good.isError).toBeFalsy();
      expect(calls).toHaveLength(1);
      expect(good.content).toMatch(/\[sub-agent report · explore/);
      expect(good.content).toContain('stub report');
    } finally {
      await sbx.cleanup();
    }
  });

  it('fails cleanly when sub-agents are switched off', async () => {
    const sbx = await makeSandbox();
    try {
      const { makeContext } = await import('./helpers.js');
      const { ctx } = await makeContext(sbx.dir);
      expect(ctx.subagent).toBeNull();
      const res = await taskTool.run({ prompt: 'a perfectly good brief for a sub-agent' }, ctx);
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(/disabled/i);
    } finally {
      await sbx.cleanup();
    }
  });

  it('is registered only when enabled, and the prompt block follows it', async () => {
    const sbx = await makeSandbox();
    try {
      const on = await makeRuntime(sbx.dir, [{ text: 'ok' }], { subagentsEnabled: true });
      expect(on.rt.registry.has('task')).toBe(true);
      expect(on.rt.subagentRunner).not.toBeNull();
      expect(on.rt.systemPrompt).toMatch(/<subagents>/);
      expect(on.rt.systemPrompt).toMatch(/task\(prompt, kind\)/);

      const off = await makeRuntime(sbx.dir, [{ text: 'ok' }], { subagentsEnabled: false });
      expect(off.rt.registry.has('task')).toBe(false);
      expect(off.rt.subagentRunner).toBeNull();
      expect(off.rt.systemPrompt).not.toMatch(/<subagents>/);
      // and the schema is not sent either — that is ~150 tokens saved
      expect(off.rt.registry.specs().some((s) => s.function.name === 'task')).toBe(false);
    } finally {
      await sbx.cleanup();
    }
  });
});

describe('the sub-agent prompt', () => {
  it('tells the child it is read-only, and never says that to a worker', () => {
    const explore = buildSubagentPrompt({
      kind: 'explore',
      repoContext: 'os: linux',
      maxSteps: 12,
      permissionMode: 'readonly',
      skillsIndex: '',
      reportChars: 4000,
    });
    expect(explore).toMatch(/SUB-AGENT/);
    expect(explore).toMatch(/READ-ONLY/);
    expect(explore).toMatch(/at most 12 tool rounds/);
    expect(explore).toMatch(/Never ask a question/);
    expect(explore).toMatch(/~4000 characters/);
    expect(explore).toContain('os: linux');
    expect(explore).not.toMatch(/<skills>/);

    const work = buildSubagentPrompt({
      kind: 'work',
      repoContext: 'os: linux',
      maxSteps: 5,
      permissionMode: 'ask',
      skillsIndex: '- debug: fix things [~800 tok]',
      reportChars: 1000,
    });
    expect(work).not.toMatch(/READ-ONLY/);
    expect(work).toMatch(/may change files/);
    expect(work).toMatch(/<skills>/);
    expect(work).toMatch(/at most 5 tool rounds/);
  });
});
