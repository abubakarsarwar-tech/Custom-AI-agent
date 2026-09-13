import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { checkPath, isIgnoredName } from '../safety/paths.js';
import { fail, int, ok, str, type Tool, type ToolContext, type ToolResult } from './types.js';

const MAX_ENTRIES = 500;

interface Node {
  name: string;
  rel: string;
  dir: boolean;
  size: number;
}

async function walk(root: string, rel: string, depth: number, budget: { n: number }): Promise<Node[]> {
  if (depth < 0 || budget.n <= 0) return [];
  const abs = path.join(root, rel);
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => {
    const da = a.isDirectory() ? 0 : 1;
    const db = b.isDirectory() ? 0 : 1;
    return da - db || a.name.localeCompare(b.name);
  });

  const out: Node[] = [];
  for (const entry of entries) {
    if (budget.n <= 0) break;
    if (entry.name.startsWith('.') && entry.name !== '.env.example') {
      // keep the tree readable; dotfiles are noise unless asked for
      if (!entry.isDirectory() || entry.name !== '.github') continue;
    }
    if (isIgnoredName(entry.name)) continue;
    const childRel = rel === '.' || rel === '' ? entry.name : `${rel}/${entry.name}`;
    let size = 0;
    if (entry.isFile()) {
      try {
        size = (await stat(path.join(root, childRel))).size;
      } catch {
        size = 0;
      }
    }
    out.push({ name: entry.name, rel: childRel, dir: entry.isDirectory(), size });
    budget.n -= 1;
    if (entry.isDirectory()) {
      out.push(...(await walk(root, childRel, depth - 1, budget)));
    }
  }
  return out;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

export const listDirTool: Tool = {
  name: 'list_dir',
  description:
    'List the files and directories in a folder as a tree, with file sizes. Skips node_modules/.git/dist. ' +
    'Use this first to learn how a project is laid out.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list. Omit or use "." for the workspace root.' },
      depth: { type: 'number', description: 'How many levels deep to recurse (default 2, max 6).' },
    },
    required: [],
  },
  risk: 'low',

  summarize: (args) => `${str(args, 'path', '.') || '.'} (depth ${int(args, 'depth', 2)})`,

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const target = str(args, 'path', '.') || '.';
    const depth = Math.min(6, Math.max(0, int(args, 'depth', 2)));
    const checked = checkPath(ctx.workspace, target);
    if (!checked.ok) return fail(checked.error ?? 'Bad path.');

    let info;
    try {
      info = await stat(checked.abs);
    } catch {
      return fail(`No such directory: ${checked.rel}`);
    }
    if (!info.isDirectory()) return fail(`${checked.rel} is a file, not a directory. Use read_file.`);

    const nodes = await walk(checked.abs, '.', depth, { n: MAX_ENTRIES });
    const lines = nodes.map((n) => {
      const indent = '  '.repeat(Math.max(0, n.rel.split('/').length - 1));
      return n.dir
        ? `${indent}${n.name}/`
        : `${indent}${n.name} ${`(${humanSize(n.size)})`}`;
    });

    const truncated = nodes.length >= MAX_ENTRIES;
    return ok(
      [`${checked.rel === '.' ? '(workspace root)' : checked.rel} — ${nodes.length} entries`, ...lines]
        .concat(truncated ? [`… truncated at ${MAX_ENTRIES} entries, narrow the path or lower depth`] : [])
        .join('\n'),
      { data: { path: checked.rel, entries: nodes.length } },
    );
  },
};
