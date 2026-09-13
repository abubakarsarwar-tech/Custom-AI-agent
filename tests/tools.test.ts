import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeContext, makeSandbox, type Sandbox } from './helpers.js';
import { readFileTool } from '../src/tools/read-file.js';
import { writeFileTool } from '../src/tools/write-file.js';
import { editFileTool } from '../src/tools/edit-file.js';
import { listDirTool } from '../src/tools/list-dir.js';
import { searchTool } from '../src/tools/search.js';
import { todoTool } from '../src/tools/todo.js';
import type { ToolContext } from '../src/tools/types.js';

let box: Sandbox;
let ctx: ToolContext;

beforeEach(async () => {
  box = await makeSandbox();
  ctx = (await makeContext(box.dir)).ctx;
});

afterEach(async () => {
  await box.cleanup();
});

describe('write_file / read_file', () => {
  it('creates a file and its parent directories', async () => {
    const res = await writeFileTool.run({ path: 'deep/nested/a.txt', content: 'hello\n' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(await box.read('deep/nested/a.txt')).toBe('hello\n');
  });

  it('reads back with line numbers', async () => {
    await box.write('b.txt', 'one\ntwo\nthree\n');
    const res = await readFileTool.run({ path: 'b.txt' }, ctx);
    expect(res.content).toContain('1\tone');
    expect(res.content).toContain('3\tthree');
    expect(res.content).toMatch(/3 lines/);
  });

  it('honours offset and limit', async () => {
    await box.write('c.txt', 'l1\nl2\nl3\nl4\nl5\n');
    const res = await readFileTool.run({ path: 'c.txt', offset: 2, limit: 2 }, ctx);
    expect(res.content).toContain('2\tl2');
    expect(res.content).toContain('3\tl3');
    expect(res.content).not.toContain('l5');
    expect(res.content).toMatch(/2 more lines after/);
  });

  it('reports a missing file with a useful hint', async () => {
    const res = await readFileTool.run({ path: 'nope.ts' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/list_dir|search/);
  });

  it('refuses to escape the workspace', async () => {
    const res = await writeFileTool.run({ path: '../evil.txt', content: 'x' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/outside the workspace/);
  });
});

describe('edit_file', () => {
  it('replaces an exact unique match', async () => {
    await box.write('d.ts', 'const a = 1;\nconst b = 2;\n');
    const res = await editFileTool.run({ path: 'd.ts', old_text: 'const b = 2;', new_text: 'const b = 3;' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(await box.read('d.ts')).toBe('const a = 1;\nconst b = 3;\n');
  });

  it('tolerates wrong indentation (the classic local-model failure)', async () => {
    await box.write('e.ts', 'function f() {\n    return 1;\n}\n');
    const res = await editFileTool.run(
      { path: 'e.ts', old_text: 'return 1;', new_text: 'return 2;' },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(await box.read('e.ts')).toContain('    return 2;');
    expect(res.data?.kind).toBe('fuzzy');
  });

  it('tolerates trailing whitespace differences', async () => {
    await box.write('f.ts', 'let x = 1;   \nlet y = 2;\n');
    const res = await editFileTool.run({ path: 'f.ts', old_text: 'let x = 1;', new_text: 'let x = 9;' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(await box.read('f.ts')).toContain('let x = 9;');
  });

  it('refuses an ambiguous match and says where the duplicates are', async () => {
    await box.write('g.ts', 'foo()\nbar()\nfoo()\n');
    const res = await editFileTool.run({ path: 'g.ts', old_text: 'foo()', new_text: 'baz()' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/2 places/);
    expect(res.content).toMatch(/replace_all/);
  });

  it('replace_all changes every occurrence', async () => {
    await box.write('h.ts', 'foo()\nbar()\nfoo()\n');
    const res = await editFileTool.run(
      { path: 'h.ts', old_text: 'foo()', new_text: 'baz()', replace_all: true },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(await box.read('h.ts')).toBe('baz()\nbar()\nbaz()\n');
  });

  it('can delete a block with an empty new_text', async () => {
    await box.write('i.ts', 'a\nb\nc\n');
    await editFileTool.run({ path: 'i.ts', old_text: 'b\n', new_text: '' }, ctx);
    expect(await box.read('i.ts')).toBe('a\nc\n');
  });

  it('suggests the closest region when nothing matches', async () => {
    await box.write('j.ts', 'const alpha = 1;\nconst beta = 2;\n');
    const res = await editFileTool.run(
      { path: 'j.ts', old_text: 'const gamma = 99;', new_text: 'x' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/not found/);
  });

  it('refuses to edit a file that does not exist', async () => {
    const res = await editFileTool.run({ path: 'missing.ts', old_text: 'a', new_text: 'b' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/write_file/);
  });

  it('rejects a no-op edit', async () => {
    await box.write('k.ts', 'same\n');
    const res = await editFileTool.run({ path: 'k.ts', old_text: 'same', new_text: 'same' }, ctx);
    expect(res.isError).toBe(true);
  });

  it('handles multi-line replacements', async () => {
    await box.write('l.ts', 'if (a) {\n  go();\n}\n');
    const res = await editFileTool.run(
      { path: 'l.ts', old_text: 'if (a) {\n  go();\n}', new_text: 'if (a && b) {\n  go();\n  log();\n}' },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(await box.read('l.ts')).toBe('if (a && b) {\n  go();\n  log();\n}\n');
  });
});

describe('list_dir', () => {
  it('renders a tree with sizes and skips noise', async () => {
    await box.write('src/a.ts', 'x');
    await box.write('src/deep/b.ts', 'y');
    await box.write('node_modules/pkg/index.js', 'z');
    const res = await listDirTool.run({ path: '.', depth: 3 }, ctx);
    expect(res.content).toContain('src/');
    expect(res.content).toContain('a.ts');
    expect(res.content).toContain('deep/');
    expect(res.content).not.toContain('node_modules');
  });

  it('rejects a file path', async () => {
    await box.write('m.txt', 'x');
    const res = await listDirTool.run({ path: 'm.txt' }, ctx);
    expect(res.isError).toBe(true);
  });
});

describe('search', () => {
  it('finds regex matches with file:line output', async () => {
    await box.write('src/x.ts', 'export function alpha() {}\n');
    await box.write('src/y.ts', 'import { alpha } from "./x";\n');
    const res = await searchTool.run({ pattern: 'alpha' }, ctx);
    expect(res.content).toMatch(/src\/x\.ts:1:/);
    expect(res.content).toMatch(/src\/y\.ts:1:/);
  });

  it('is case-insensitive by default', async () => {
    await box.write('n.ts', 'ConstValue = 1\n');
    expect((await searchTool.run({ pattern: 'constvalue' }, ctx)).content).toMatch(/n\.ts:1/);
  });

  it('filters by glob', async () => {
    await box.write('o.ts', 'needle\n');
    await box.write('o.md', 'needle\n');
    const res = await searchTool.run({ pattern: 'needle', glob: '*.md' }, ctx);
    expect(res.content).toMatch(/o\.md/);
    expect(res.content).not.toMatch(/o\.ts/);
  });

  it('reports no matches with guidance instead of an error', async () => {
    await box.write('p.ts', 'nothing here\n');
    const res = await searchTool.run({ pattern: 'zzzz' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/No matches/);
  });

  it('tells the model when the regex is invalid', async () => {
    const res = await searchTool.run({ pattern: '([unclosed' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/literal=true/);
  });

  it('supports literal mode', async () => {
    await box.write('q.ts', 'a.b*c\n');
    const res = await searchTool.run({ pattern: 'a.b*c', literal: true }, ctx);
    expect(res.content).toMatch(/q\.ts:1/);
  });
});

describe('todo_write', () => {
  it('stores and renders a plan', async () => {
    const res = await todoTool.run(
      {
        todos: [
          { content: 'Read the code', status: 'completed' },
          { content: 'Fix the bug', status: 'in_progress' },
          { content: 'Add a test', status: 'pending' },
        ],
      },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(ctx.session.plan.all()).toHaveLength(3);
    expect(ctx.session.plan.done).toBe(1);
    expect(res.content).toMatch(/\[x\] Read the code/);
    expect(res.content).toMatch(/\[~\] Fix the bug/);
  });

  it('accepts sloppy status words from small models', async () => {
    await todoTool.run({ todos: [{ content: 'task', status: 'done' }] }, ctx);
    expect(ctx.session.plan.all()[0]?.status).toBe('completed');
    await todoTool.run({ todos: [{ content: 'task', status: 'DOING' }] }, ctx);
    expect(ctx.session.plan.all()[0]?.status).toBe('in_progress');
  });

  it('clears the plan', async () => {
    await todoTool.run({ todos: [{ content: 'task', status: 'pending' }] }, ctx);
    await todoTool.run({ clear: true }, ctx);
    expect(ctx.session.plan.isEmpty).toBe(true);
  });
});
