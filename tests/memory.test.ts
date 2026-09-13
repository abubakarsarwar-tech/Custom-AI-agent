import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { LessonStore } from '../src/memory/lessons.js';
import { rememberTool } from '../src/tools/remember.js';
import { makeContext, makeRuntime, makeSandbox, type Sandbox } from './helpers.js';

/** LessonStore.open wants the state dir (…/.agent), not the memory dir. */
function storeFor(sbx: Sandbox): Promise<LessonStore> {
  return LessonStore.open(path.join(sbx.dir, '.agent'));
}

describe('LessonStore — saving', () => {
  it('adds a lesson with an id, score 1 and the given tags', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const lesson = await store.add('Use pnpm in this repo, never npm', {
        tags: ['Tooling', 'pnpm'],
        source: 'user',
      });

      expect(lesson.id).toMatch(/^l_/);
      expect(lesson.score).toBe(1);
      expect(lesson.source).toBe('user');
      // tags are lower-cased and de-duplicated
      expect(lesson.tags).toEqual(['tooling', 'pnpm']);
      expect(store.count).toBe(1);
    } finally {
      await sbx.cleanup();
    }
  });

  it('refuses empty text', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      await expect(store.add('   ')).rejects.toThrow(/needs some text/i);
      expect(store.count).toBe(0);
    } finally {
      await sbx.cleanup();
    }
  });

  it('deduplicates: the same fact twice bumps the score instead of repeating', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const first = await store.add('Always run prettier before committing.');
      const second = await store.add('  always run PRETTIER before committing  ');

      expect(store.count).toBe(1);
      expect(second.id).toBe(first.id);
      expect(second.score).toBe(2);
      // the new tag is merged into the existing lesson
      const third = await store.add('Always run prettier before committing.', { tags: ['git'] });
      expect(third.tags).toContain('git');
      expect(store.count).toBe(1);
    } finally {
      await sbx.cleanup();
    }
  });

  it('writes append-only JSONL that a human can grep', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      await store.add('First fact');
      await store.add('Second fact');

      const raw = await readFile(store.path, 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).text).toBe('First fact');
      expect(store.path.endsWith(path.join('.agent', 'memory', 'lessons.jsonl'))).toBe(true);
    } finally {
      await sbx.cleanup();
    }
  });
});

describe('LessonStore — persistence', () => {
  it('reloads what a previous session wrote', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const saved = await store.add('Tests live in tests/, one suite per module.');
      await store.vote(saved.id, 1);

      const reopened = await storeFor(sbx);
      expect(reopened.count).toBe(1);
      const lesson = reopened.all()[0]!;
      expect(lesson.text).toBe('Tests live in tests/, one suite per module.');
      expect(lesson.score).toBe(2); // 1 on save + 1 vote
    } finally {
      await sbx.cleanup();
    }
  });

  it('survives a truncated final line (crash mid-write)', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      await store.add('Good line');
      const partial = path.join(sbx.dir, '.agent', 'memory', 'lessons.jsonl');
      const { appendFile } = await import('node:fs/promises');
      await appendFile(partial, '{"id":"l_broken","text":"cut off mid');

      const reopened = await storeFor(sbx);
      expect(reopened.count).toBe(1);
      expect(reopened.all()[0]!.text).toBe('Good line');
    } finally {
      await sbx.cleanup();
    }
  });

  it('starts empty when the file does not exist yet', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      expect(store.count).toBe(0);
      expect(store.all()).toEqual([]);
    } finally {
      await sbx.cleanup();
    }
  });
});

describe('LessonStore — voting and forgetting', () => {
  it('votes up and down, and reports unknown ids', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const lesson = await store.add('Prefer named exports.');

      expect((await store.vote(lesson.id, 1))?.score).toBe(2);
      expect((await store.vote(lesson.id, -1))?.score).toBe(1);
      expect(await store.vote('l_nope', 1)).toBeNull();
    } finally {
      await sbx.cleanup();
    }
  });

  it('removes a lesson and rewrites the file without it', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const keep = await store.add('Keep this one');
      const drop = await store.add('Drop this one');

      expect(await store.remove(drop.id)).toBe(true);
      expect(await store.remove(drop.id)).toBe(false);
      expect(store.count).toBe(1);
      expect(store.all()[0]!.id).toBe(keep.id);

      const raw = await readFile(store.path, 'utf8');
      expect(raw).toContain('Keep this one');
      expect(raw).not.toContain('Drop this one');
    } finally {
      await sbx.cleanup();
    }
  });
});

describe('LessonStore — recall', () => {
  async function seeded(): Promise<{ store: LessonStore; sbx: Sandbox }> {
    const sbx = await makeSandbox();
    const store = await storeFor(sbx);
    await store.add('Use pnpm, never npm, in this repo', { tags: ['pnpm', 'tooling'] });
    await store.add('Tests live in tests/ and use vitest', { tags: ['testing'] });
    await store.add('Never commit .env files', { tags: ['git', 'security'] });
    return { store, sbx };
  }

  it('recalls the lesson that matches the message', async () => {
    const { store, sbx } = await seeded();
    try {
      const hits = store.relevant('how do I run the tests in this project?');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.lesson.text).toMatch(/vitest/);
    } finally {
      await sbx.cleanup();
    }
  });

  it('returns nothing for an unrelated message', async () => {
    const { store, sbx } = await seeded();
    try {
      expect(store.relevant('zzz qqq xyzzy')).toEqual([]);
    } finally {
      await sbx.cleanup();
    }
  });

  it('weights tag matches above body matches', async () => {
    const { store, sbx } = await seeded();
    try {
      const hits = store.relevant('pnpm install is failing');
      expect(hits[0]!.lesson.text).toMatch(/pnpm/);
    } finally {
      await sbx.cleanup();
    }
  });

  it('respects the limit', async () => {
    const { store, sbx } = await seeded();
    try {
      await store.add('Use pnpm workspaces for the monorepo layout', { tags: ['pnpm'] });
      const hits = store.relevant('pnpm and tests and git and .env', 2);
      expect(hits.length).toBeLessThanOrEqual(2);
    } finally {
      await sbx.cleanup();
    }
  });

  it('sinks a lesson that was voted down twice', async () => {
    const { store, sbx } = await seeded();
    try {
      const lesson = store.all().find((l) => l.text.includes('pnpm'))!;
      await store.vote(lesson.id, -1);
      await store.vote(lesson.id, -1);
      await store.vote(lesson.id, -1); // score now -2

      const hits = store.relevant('pnpm install keeps failing here');
      expect(hits.map((h) => h.lesson.id)).not.toContain(lesson.id);
      // still listed for the user to inspect and delete
      expect(store.all().some((l) => l.id === lesson.id)).toBe(true);
    } finally {
      await sbx.cleanup();
    }
  });

  it('renders an injection block that starts with "[" and exposes ids', async () => {
    const { store, sbx } = await seeded();
    try {
      const block = store.renderBlockWithIds('the tests in this repo');
      expect(block.text.startsWith('[remembered from earlier sessions]')).toBe(true);
      expect(block.ids.length).toBeGreaterThan(0);
      expect(block.text).toMatch(/^- /m);

      const empty = store.renderBlockWithIds('zzz qqq');
      expect(empty.text).toBe('');
      expect(empty.ids).toEqual([]);
      expect(store.renderBlock('zzz qqq')).toBe('');
    } finally {
      await sbx.cleanup();
    }
  });
});

describe('remember tool', () => {
  it('saves, searches and forgets through one tool', async () => {
    const sbx = await makeSandbox();
    try {
      const { ctx } = await makeCtx(sbx, await storeFor(sbx));

      const saved = await rememberTool.run(
        { text: 'Always use vitest for tests', tags: ['testing'] },
        ctx,
      );
      expect(saved.isError).toBeFalsy();
      expect(saved.content).toMatch(/remembered/i);

      const found = await rememberTool.run({ query: 'which test runner do we use' }, ctx);
      expect(found.isError).toBeFalsy();
      expect(found.content).toMatch(/vitest/i);

      const id = ctx.memory!.all()[0]!.id;
      const forgot = await rememberTool.run({ forget: id }, ctx);
      expect(forgot.isError).toBeFalsy();
      expect(ctx.memory!.count).toBe(0);
    } finally {
      await sbx.cleanup();
    }
  });

  it('fails cleanly when memory is disabled', async () => {
    const sbx = await makeSandbox();
    try {
      const { ctx } = await makeCtx(sbx, null);
      const res = await rememberTool.run({ text: 'anything' }, ctx);
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(/disabled/i);
    } finally {
      await sbx.cleanup();
    }
  });
});

/** makeContext opens its own store when memoryEnabled is true. */
function makeCtx(sbx: Sandbox, memory: LessonStore | null) {
  return makeContext(sbx.dir, { memoryEnabled: memory !== null });
}

describe('runtime memory integration', () => {
  it('injects a recalled lesson as a bracketed user message', async () => {
    const sbx = await makeSandbox();
    try {
      // Seed the file the runtime will open on create().
      const seed = await storeFor(sbx);
      await seed.add('In this repo, tests are run with vitest', { tags: ['testing'] });

      const { rt } = await makeRuntime(sbx.dir, [{ text: 'Noted — vitest it is.' }], {
        permissionMode: 'auto',
      });
      await rt.send('how do I run the tests here?');

      const injected = rt.messages.filter((m) => m.content.startsWith('[remembered'));
      expect(injected.length).toBeGreaterThan(0);
      expect(injected[0]!.content).toMatch(/vitest/);
      expect(injected[0]!.role).toBe('user');
      // and it is tracked so 👍/👎 knows what to vote on
      expect(rt.lastInjectedLessons.length).toBeGreaterThan(0);
    } finally {
      await sbx.cleanup();
    }
  });

  it('injects nothing when no lesson is relevant', async () => {
    const sbx = await makeSandbox();
    try {
      const seed = await storeFor(sbx);
      await seed.add('Deploy with the release script on Fridays');

      const { rt } = await makeRuntime(sbx.dir, [{ text: 'Hello.' }]);
      await rt.send('qqq zzz unrelated question');
      expect(rt.messages.some((m) => m.content.startsWith('[remembered'))).toBe(false);
    } finally {
      await sbx.cleanup();
    }
  });

  it('registers the remember tool only when memory is on', async () => {
    const sbx = await makeSandbox();
    try {
      const seed = await storeFor(sbx);
      await seed.add('A convention worth remembering');
      const on = await makeRuntime(sbx.dir, [{ text: 'ok' }], { memoryEnabled: true });
      expect(on.rt.registry.has('remember')).toBe(true);
      // the stats line only mentions memory once there is something in it
      expect(on.rt.statsLine()).toMatch(/memory 1/);

      const off = await makeRuntime(sbx.dir, [{ text: 'ok' }], { memoryEnabled: false });
      expect(off.rt.registry.has('remember')).toBe(false);
      expect(off.rt.memory).toBeNull();
    } finally {
      await sbx.cleanup();
    }
  });

  it('mentions memory in the system prompt', async () => {
    const sbx = await makeSandbox();
    try {
      const seed = await storeFor(sbx);
      await seed.add('Some project convention');
      const { rt } = await makeRuntime(sbx.dir, [{ text: 'ok' }]);
      expect(rt.systemPrompt).toMatch(/<memory>/);
      expect(rt.systemPrompt).toMatch(/remember/);
    } finally {
      await sbx.cleanup();
    }
  });
});
