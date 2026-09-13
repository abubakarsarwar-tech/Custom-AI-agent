import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CheckpointStore, humanBytes } from '../src/agent/checkpoint.js';
import { makeRuntime, makeSandbox, type Sandbox } from './helpers.js';

function storeFor(sbx: Sandbox, keep = 20): Promise<CheckpointStore> {
  return CheckpointStore.open(path.join(sbx.dir, '.agent'), { keep });
}

async function seed(sbx: Sandbox, rel: string, content: string): Promise<string> {
  const abs = path.join(sbx.dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
  return abs;
}

const read = (sbx: Sandbox, rel: string): Promise<string> =>
  readFile(path.join(sbx.dir, rel), 'utf8');

describe('CheckpointStore — capture and restore', () => {
  it('reverts a modified file to its pre-turn content', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const abs = await seed(sbx, 'src/app.ts', 'const a = 1;\n');

      store.begin('change the constant');
      expect(await store.capture('src/app.ts', abs, 'const a = 1;\n')).toBe(true);
      await writeFile(abs, 'const a = 2;\n', 'utf8'); // what the tool would do
      const cp = await store.finish();

      expect(cp).not.toBeNull();
      expect(cp!.files).toEqual([{ rel: 'src/app.ts', existed: true, bytes: 13 }]);

      const result = await store.restore(cp!.id, sbx.dir);
      expect(result!.reverted).toEqual(['src/app.ts']);
      expect(result!.deleted).toEqual([]);
      expect(await read(sbx, 'src/app.ts')).toBe('const a = 1;\n');
    } finally {
      await sbx.cleanup();
    }
  });

  it('deletes a file the agent created', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const abs = path.join(sbx.dir, 'new-file.txt');

      store.begin('create something');
      expect(await store.capture('new-file.txt', abs, null)).toBe(true);
      await writeFile(abs, 'brand new\n', 'utf8');
      const cp = await store.finish();

      const result = await store.restore(cp!.id, sbx.dir);
      expect(result!.deleted).toEqual(['new-file.txt']);
      expect(existsSync(abs)).toBe(false);
    } finally {
      await sbx.cleanup();
    }
  });

  it('the FIRST capture wins, so a restore lands on the pre-turn state', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const abs = await seed(sbx, 'counter.txt', 'v1\n');

      store.begin('three edits in one turn');
      await store.capture('counter.txt', abs, 'v1\n');
      await writeFile(abs, 'v2\n', 'utf8');
      // second and third writes of the same file must not overwrite the backup
      expect(await store.capture('counter.txt', abs, 'v2\n')).toBe(false);
      await writeFile(abs, 'v3\n', 'utf8');
      expect(await store.capture('counter.txt', abs, 'v3\n')).toBe(false);
      const cp = await store.finish();

      expect(cp!.files).toHaveLength(1);
      expect(cp!.files[0]!.bytes).toBe(3); // "v1\n", not "v3\n"
      await store.restore(cp!.id, sbx.dir);
      expect(await read(sbx, 'counter.txt')).toBe('v1\n');
    } finally {
      await sbx.cleanup();
    }
  });

  it('reads the file itself when the tool has no content to hand over', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const abs = await seed(sbx, 'a.txt', 'from disk\n');

      store.begin('no preload');
      expect(await store.capture('a.txt', abs)).toBe(true);
      await writeFile(abs, 'clobbered\n', 'utf8');
      const cp = await store.finish();

      await store.restore(cp!.id, sbx.dir);
      expect(await read(sbx, 'a.txt')).toBe('from disk\n');
    } finally {
      await sbx.cleanup();
    }
  });

  it('captures nothing when no turn is open', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      expect(await store.capture('x.txt', path.join(sbx.dir, 'x.txt'), null)).toBe(false);
      expect(await store.finish()).toBeNull();
    } finally {
      await sbx.cleanup();
    }
  });

  it('finish() is null for a turn that changed no files', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      store.begin('just a question');
      expect(await store.finish()).toBeNull();
      expect(store.count).toBe(0);
      expect(existsSync(store.root)).toBe(false); // nothing written at all
    } finally {
      await sbx.cleanup();
    }
  });

  it('discard() throws away an aborted turn', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const abs = await seed(sbx, 'a.txt', 'one\n');
      store.begin('aborted');
      await store.capture('a.txt', abs, 'one\n');
      store.discard();
      expect(await store.finish()).toBeNull();
      expect(store.count).toBe(0);
    } finally {
      await sbx.cleanup();
    }
  });
});

describe('CheckpointStore — persistence and pruning', () => {
  it('writes a readable manifest and reloads it', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const abs = await seed(sbx, 'src/x.ts', 'export const x = 1;\n');
      store.begin('persist me');
      await store.capture('src/x.ts', abs, 'export const x = 1;\n');
      const cp = await store.finish();

      const manifest = path.join(store.root, cp!.id, 'manifest.json');
      const onDisk = JSON.parse(await readFile(manifest, 'utf8')) as { label: string };
      expect(onDisk.label).toBe('persist me');

      const reopened = await storeFor(sbx);
      expect(reopened.count).toBe(1);
      const listed = reopened.list()[0]!;
      expect(listed.id).toBe(cp!.id);
      expect(listed.label).toBe('persist me');
      expect(listed.files[0]!.rel).toBe('src/x.ts');

      // and the backup really is on disk, in the file's own shape
      const backup = path.join(store.root, cp!.id, 'files', 'src', 'x.ts');
      expect(await readFile(backup, 'utf8')).toBe('export const x = 1;\n');
    } finally {
      await sbx.cleanup();
    }
  });

  it('lists newest first', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      for (const name of ['first', 'second', 'third']) {
        const abs = await seed(sbx, `${name}.txt`, `${name}\n`);
        store.begin(name);
        await store.capture(`${name}.txt`, abs, `${name}\n`);
        await store.finish();
        // timestamps are ms-resolution; keep the order unambiguous
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(store.list().map((c) => c.label)).toEqual(['third', 'second', 'first']);
    } finally {
      await sbx.cleanup();
    }
  });

  it('prunes the oldest beyond the keep limit, folders and all', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx, 2);
      const ids: string[] = [];
      for (const name of ['a', 'b', 'c']) {
        const abs = await seed(sbx, `${name}.txt`, `${name}\n`);
        store.begin(name);
        await store.capture(`${name}.txt`, abs, `${name}\n`);
        ids.push((await store.finish())!.id);
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(store.count).toBe(2);
      expect(store.list().map((c) => c.label)).toEqual(['c', 'b']);
      expect(existsSync(path.join(store.root, ids[0]!))).toBe(false);
      expect(existsSync(path.join(store.root, ids[2]!))).toBe(true);
    } finally {
      await sbx.cleanup();
    }
  });

  it('ignores a manifest corrupted by a crash mid-write', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const abs = await seed(sbx, 'good.txt', 'good\n');
      store.begin('good turn');
      await store.capture('good.txt', abs, 'good\n');
      await store.finish();

      const broken = path.join(store.root, 'cp_broken_x1');
      await mkdir(broken, { recursive: true });
      await writeFile(path.join(broken, 'manifest.json'), '{"id":"cp_broken","files":[', 'utf8');

      const reopened = await storeFor(sbx);
      expect(reopened.count).toBe(1);
      expect(reopened.list()[0]!.label).toBe('good turn');
    } finally {
      await sbx.cleanup();
    }
  });

  it('clear() removes everything', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const abs = await seed(sbx, 'a.txt', 'a\n');
      store.begin('x');
      await store.capture('a.txt', abs, 'a\n');
      await store.finish();

      expect(await store.clear()).toBe(1);
      expect(store.count).toBe(0);
      expect(existsSync(store.root)).toBe(false);
    } finally {
      await sbx.cleanup();
    }
  });

  it('reports its own size', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const abs = await seed(sbx, 'a.txt', 'x'.repeat(2048));
      store.begin('size');
      await store.capture('a.txt', abs, 'x'.repeat(2048));
      await store.finish();

      const bytes = await store.sizeBytes();
      expect(bytes).toBeGreaterThanOrEqual(2048);
      expect(humanBytes(bytes)).toMatch(/KB|B$/);
      expect(humanBytes(500)).toBe('500 B');
      expect(humanBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    } finally {
      await sbx.cleanup();
    }
  });
});

describe('CheckpointStore — restore is never the irreversible move', () => {
  it('snapshots the state it is leaving, so a restore can be undone', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const abs = await seed(sbx, 'a.txt', 'original\n');

      store.begin('agent edits');
      await store.capture('a.txt', abs, 'original\n');
      await writeFile(abs, 'agent version\n', 'utf8');
      const cp = await store.finish();

      expect(store.count).toBe(1);
      await store.restore(cp!.id, sbx.dir);
      expect(await read(sbx, 'a.txt')).toBe('original\n');

      // the pre-restore state was itself checkpointed
      expect(store.count).toBe(2);
      const undo = store.list()[0]!;
      expect(undo.label).toMatch(/state before restoring/);

      // ...so undoing the undo brings the agent's version back
      await store.restore(undo.id, sbx.dir);
      expect(await read(sbx, 'a.txt')).toBe('agent version\n');
    } finally {
      await sbx.cleanup();
    }
  });

  it('marks a checkpoint as restored', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const abs = await seed(sbx, 'a.txt', 'one\n');
      store.begin('mark me');
      await store.capture('a.txt', abs, 'one\n');
      const cp = await store.finish();

      expect(store.get(cp!.id)!.restoredAt).toBeUndefined();
      await store.restore(cp!.id, sbx.dir);
      expect(store.get(cp!.id)!.restoredAt).toBeTruthy();

      // and the marker survives a reload
      const reopened = await storeFor(sbx);
      expect(reopened.get(cp!.id)!.restoredAt).toBeTruthy();
    } finally {
      await sbx.cleanup();
    }
  });

  it('returns null for an unknown id', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      expect(await store.restore('cp_nope', sbx.dir)).toBeNull();
    } finally {
      await sbx.cleanup();
    }
  });

  it('leaves the file alone when the backup has gone missing', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const abs = await seed(sbx, 'a.txt', 'original\n');
      store.begin('lose the backup');
      await store.capture('a.txt', abs, 'original\n');
      await writeFile(abs, 'changed\n', 'utf8');
      const cp = await store.finish();

      const { rm } = await import('node:fs/promises');
      await rm(path.join(store.root, cp!.id, 'files'), { recursive: true, force: true });

      const result = await store.restore(cp!.id, sbx.dir);
      expect(result!.reverted).toEqual([]);
      expect(await read(sbx, 'a.txt')).toBe('changed\n'); // not guessed, not emptied
    } finally {
      await sbx.cleanup();
    }
  });
});

describe('CheckpointStore — path safety', () => {
  it('refuses to store a backup for a path that escapes the checkpoint folder', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      store.begin('escape attempt');
      const ok = await store.capture(
        '../../../../tmp/pwned.txt',
        path.join(sbx.dir, 'whatever.txt'),
        'x',
      );
      // the capture is dropped rather than writing outside the store
      expect(ok).toBe(false);
      expect(await store.finish()).toBeNull();
      expect(existsSync('/tmp/pwned.txt')).toBe(false);
    } finally {
      await sbx.cleanup();
    }
  });

  it('keeps a file whose name contains dots and dashes', async () => {
    const sbx = await makeSandbox();
    try {
      const store = await storeFor(sbx);
      const abs = await seed(sbx, 'src/.env.example', 'A=1\n');
      store.begin('dotty');
      await store.capture('src/.env.example', abs, 'A=1\n');
      await writeFile(abs, 'A=2\n', 'utf8');
      const cp = await store.finish();

      await store.restore(cp!.id, sbx.dir);
      expect(await read(sbx, 'src/.env.example')).toBe('A=1\n');
    } finally {
      await sbx.cleanup();
    }
  });
});

describe('runtime integration', () => {
  it('checkpoints a write_file turn and rolls it back', async () => {
    const sbx = await makeSandbox();
    try {
      await seed(sbx, 'app.js', 'console.log("before");\n');
      const { rt } = await makeRuntime(
        sbx.dir,
        [
          {
            text: 'Rewriting it.',
            toolCalls: [
              { name: 'write_file', arguments: { path: 'app.js', content: 'console.log("after");\n' } },
            ],
          },
          { text: 'Done.' },
        ],
        { permissionMode: 'auto' },
      );

      await rt.send('rewrite app.js');
      expect(await read(sbx, 'app.js')).toBe('console.log("after");\n');

      const list = rt.checkpointList();
      expect(list).toHaveLength(1);
      expect(list[0]!.files.map((f) => f.rel)).toEqual(['app.js']);
      expect(list[0]!.label).toBe('rewrite app.js');

      const result = await rt.restoreCheckpoint(list[0]!.id);
      expect(result!.reverted).toEqual(['app.js']);
      expect(await read(sbx, 'app.js')).toBe('console.log("before");\n');
    } finally {
      await sbx.cleanup();
    }
  });

  it('checkpoints an edit_file turn', async () => {
    const sbx = await makeSandbox();
    try {
      await seed(sbx, 'lib.ts', 'export const a = 1;\nexport const b = 2;\n');
      const { rt } = await makeRuntime(
        sbx.dir,
        [
          {
            text: '',
            toolCalls: [
              {
                name: 'edit_file',
                arguments: { path: 'lib.ts', old_text: 'export const b = 2;', new_text: 'export const b = 3;' },
              },
            ],
          },
          { text: 'Edited.' },
        ],
        { permissionMode: 'auto' },
      );

      await rt.send('bump b');
      expect(await read(sbx, 'lib.ts')).toContain('b = 3');

      const cp = rt.checkpointList()[0]!;
      await rt.restoreCheckpoint(cp.id);
      expect(await read(sbx, 'lib.ts')).toContain('b = 2');
    } finally {
      await sbx.cleanup();
    }
  });

  it('removes a file the agent created during the turn', async () => {
    const sbx = await makeSandbox();
    try {
      const { rt } = await makeRuntime(
        sbx.dir,
        [
          {
            text: '',
            toolCalls: [{ name: 'write_file', arguments: { path: 'generated.txt', content: 'hi\n' } }],
          },
          { text: 'Created it.' },
        ],
        { permissionMode: 'auto' },
      );

      await rt.send('make a file');
      expect(existsSync(path.join(sbx.dir, 'generated.txt'))).toBe(true);

      const cp = rt.checkpointList()[0]!;
      expect(cp.files[0]!.existed).toBe(false);
      const result = await rt.restoreCheckpoint(cp.id);
      expect(result!.deleted).toEqual(['generated.txt']);
      expect(existsSync(path.join(sbx.dir, 'generated.txt'))).toBe(false);
    } finally {
      await sbx.cleanup();
    }
  });

  it('creates no checkpoint for a turn that only reads', async () => {
    const sbx = await makeSandbox();
    try {
      await seed(sbx, 'a.txt', 'content\n');
      const { rt } = await makeRuntime(
        sbx.dir,
        [
          { text: '', toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
          { text: 'It says content.' },
        ],
        { permissionMode: 'auto' },
      );

      await rt.send('read a.txt');
      expect(rt.checkpointList()).toEqual([]);
      expect(existsSync(path.join(sbx.dir, '.agent', 'checkpoints'))).toBe(false);
    } finally {
      await sbx.cleanup();
    }
  });

  it('keeps the checkpoint when the turn is aborted mid-way', async () => {
    const sbx = await makeSandbox();
    try {
      const { rt } = await makeRuntime(
        sbx.dir,
        [
          {
            text: '',
            toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'written\n' } }],
          },
          // the next step would run forever; we abort instead
          { text: 'still going' },
        ],
        { permissionMode: 'auto', maxSteps: 1 },
      );

      await rt.send('do work');
      // hit the step limit, but the file that WAS written is still reversible
      expect(await read(sbx, 'a.txt')).toBe('written\n');
      const list = rt.checkpointList();
      expect(list).toHaveLength(1);
      await rt.restoreCheckpoint(list[0]!.id);
      expect(existsSync(path.join(sbx.dir, 'a.txt'))).toBe(false);
    } finally {
      await sbx.cleanup();
    }
  });

  it('is switched off by config, and says so in the prompt only when on', async () => {
    const sbx = await makeSandbox();
    try {
      const off = await makeRuntime(sbx.dir, [{ text: 'hi' }], { checkpointsEnabled: false });
      expect(off.rt.checkpoints).toBeNull();
      expect(off.rt.checkpointList()).toEqual([]);
      expect(await off.rt.restoreCheckpoint('cp_anything')).toBeNull();
      expect(off.rt.systemPrompt).not.toMatch(/Rollback:/);
      expect(await off.rt.checkpointSummary()).toBe('checkpoints off');

      const on = await makeRuntime(sbx.dir, [{ text: 'hi' }], { checkpointsEnabled: true });
      expect(on.rt.checkpoints).not.toBeNull();
      expect(on.rt.systemPrompt).toMatch(/Rollback:/);
      expect(await on.rt.checkpointSummary()).toMatch(/0 checkpoint/);
    } finally {
      await sbx.cleanup();
    }
  });
});
