import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { checkPath, isIgnoredName, looksBinary } from '../safety/paths.js';
import { bool, fail, int, ok, optStr, str, type Tool, type ToolContext, type ToolResult } from './types.js';

const MAX_RESULTS = 60;
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 512_000;

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

async function collectFiles(root: string, rel: string, acc: string[], budget: { n: number }): Promise<void> {
  if (budget.n <= 0) return;
  const abs = path.join(root, rel);
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.n <= 0) return;
    if (isIgnoredName(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.isDirectory() && entry.name !== '.github') continue;
    const childRel = rel === '.' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectFiles(root, childRel, acc, budget);
    } else if (entry.isFile()) {
      acc.push(childRel);
      budget.n -= 1;
    }
  }
}

export const searchTool: Tool = {
  name: 'search',
  description:
    'Search file contents across the workspace (regex by default). Returns "path:line: content" matches. ' +
    'Use it to find function definitions, imports, config keys, or every caller of something. ' +
    'Much cheaper than reading many files.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'Directory or file to search in (default: workspace root).' },
      glob: { type: 'string', description: 'Filename filter, e.g. "*.ts" or "src/**/*.py".' },
      literal: { type: 'boolean', description: 'Treat pattern as a literal string, not a regex.' },
      case_sensitive: { type: 'boolean', description: 'Default false (case-insensitive).' },
      max_results: { type: 'number', description: `Cap on matches (default ${MAX_RESULTS}).` },
    },
    required: ['pattern'],
  },
  risk: 'low',

  summarize: (args) => `/${str(args, 'pattern')}/ in ${str(args, 'path', '.') || '.'}`,

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = str(args, 'pattern');
    if (!pattern) return fail('search requires a "pattern".');

    const scope = str(args, 'path', '.') || '.';
    const checked = checkPath(ctx.workspace, scope);
    if (!checked.ok) return fail(checked.error ?? 'Bad path.');

    const isLiteral = bool(args, 'literal', false);
    const caseSensitive = bool(args, 'case_sensitive', false);
    const maxResults = Math.min(500, Math.max(1, int(args, 'max_results', MAX_RESULTS)));
    const globArg = optStr(args, 'glob');

    let re: RegExp;
    try {
      const src = isLiteral ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
      re = new RegExp(src, caseSensitive ? 'g' : 'gi');
    } catch (err) {
      return fail(
        `Invalid regex "${pattern}": ${err instanceof Error ? err.message : String(err)}. ` +
          'Pass literal=true to search for the plain string.',
      );
    }

    const globRe = globArg ? globToRegExp(globArg.replace(/^\*\//, '')) : null;

    let files: string[] = [];
    let info;
    try {
      info = await stat(checked.abs);
    } catch {
      return fail(`No such path: ${checked.rel}`);
    }
    if (info.isFile()) {
      files = [checked.rel];
    } else {
      await collectFiles(checked.abs, '.', files, { n: MAX_FILES });
    }

    if (globRe) {
      files = files.filter((f) => globRe.test(f) || globRe.test(path.basename(f)));
    }

    const matches: string[] = [];
    let filesWithHits = 0;
    let scanned = 0;

    outer: for (const rel of files) {
      if (matches.length >= maxResults) break;
      const abs = path.join(ctx.workspace, rel);
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      let buf;
      try {
        buf = await readFile(abs);
      } catch {
        continue;
      }
      scanned += 1;
      if (looksBinary(buf)) continue;
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      let hitHere = false;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        re.lastIndex = 0;
        if (re.test(line)) {
          hitHere = true;
          matches.push(`${rel}:${i + 1}: ${line.trim().slice(0, 300)}`);
          if (matches.length >= maxResults) break outer;
        }
      }
      if (hitHere) filesWithHits += 1;
    }

    if (matches.length === 0) {
      return ok(
        `No matches for /${pattern}/ in ${checked.rel} (${scanned} files scanned). ` +
          'Try a shorter pattern, drop the glob filter, or check spelling.',
        { data: { matches: 0 } },
      );
    }

    const header = `${matches.length} match${matches.length === 1 ? '' : 'es'} in ${filesWithHits} file(s) for /${pattern}/`;
    const body = matches.join('\n');
    const more = matches.length >= maxResults ? `\n(capped at ${maxResults}; narrow the path or glob)` : '';
    return ok(`${header}\n${body}${more}`, {
      data: { matches: matches.length, filesScanned: scanned },
    });
  },
};
