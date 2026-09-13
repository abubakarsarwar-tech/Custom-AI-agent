import { readFile, writeFile } from 'node:fs/promises';
import { checkPath } from '../safety/paths.js';
import { diffLines, renderDiff } from '../util/diff.js';
import { bool, fail, ok, str, type Tool, type ToolContext, type ToolResult } from './types.js';

interface MatchResult {
  startLine: number;
  endLine: number; // exclusive
  kind: 'exact' | 'fuzzy';
  score: number;
}

function normaliseLine(line: string): string {
  return line.replace(/\r$/, '').replace(/\s+$/g, '').replace(/^\s+/g, '');
}

function normaliseBlock(lines: string[]): string[] {
  return lines.map(normaliseLine).filter((l, i, arr) => !(l === '' && arr[i - 1] === '' && i > 0));
}

/** All exact line-window matches of `needle` in `haystack`. */
function findExact(haystack: string[], needle: string[]): number[] {
  const hits: number[] = [];
  if (needle.length === 0 || needle.length > haystack.length) return hits;
  for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) hits.push(i);
  }
  return hits;
}

/**
 * Whitespace/indentation-tolerant match. Local models constantly get
 * indentation slightly wrong, and a naive string-replace editor fails the whole
 * task over two spaces. This is the single highest-value robustness trick in a
 * home-built agent.
 */
function findFuzzy(haystack: string[], needle: string[]): MatchResult | null {
  const normHay = haystack.map(normaliseLine);
  const normNeedle = needle.map(normaliseLine);
  if (normNeedle.length === 0 || normNeedle.length > normHay.length) return null;

  let best: MatchResult | null = null;
  for (let i = 0; i <= normHay.length - normNeedle.length; i += 1) {
    let same = 0;
    for (let j = 0; j < normNeedle.length; j += 1) {
      if (normHay[i + j] === normNeedle[j]) same += 1;
    }
    const score = same / normNeedle.length;
    if (score === 1 && (!best || score > best.score)) {
      best = { startLine: i, endLine: i + normNeedle.length, kind: 'fuzzy', score };
      break;
    }
    if (score >= 0.85 && (!best || score > best.score)) {
      best = { startLine: i, endLine: i + normNeedle.length, kind: 'fuzzy', score };
    }
  }
  return best;
}

/** Point the model at the region it probably meant. */
function bestGuess(haystack: string[], needle: string[]): string {
  const key = normaliseLine(needle[0] ?? '');
  if (!key) return '';
  for (let i = 0; i < haystack.length; i += 1) {
    if (normaliseLine(haystack[i] ?? '') === key) {
      const from = Math.max(0, i - 2);
      const to = Math.min(haystack.length, i + needle.length + 2);
      return [
        `Closest region in the file (lines ${from + 1}-${to}):`,
        ...haystack.slice(from, to).map((l, k) => `${from + k + 1}\t${l}`),
      ].join('\n');
    }
  }
  return '';
}

/** Shift a block of new text so its first line sits at `indent`, keeping relative depth. */
function reindent(newLines: string[], indent: string): string[] {
  const nonEmpty = newLines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return newLines;
  const indents = nonEmpty.map((l) => l.match(/^[ \t]*/)?.[0] ?? '');
  const base = indents.reduce((a, b) => (b.length < a.length ? b : a), indents[0] ?? '');
  return newLines.map((l) => {
    if (!l.trim()) return '';
    const own = l.match(/^[ \t]*/)?.[0] ?? '';
    const rel = own.startsWith(base) ? own.slice(base.length) : '';
    return indent + rel + l.slice(own.length);
  });
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Replace an exact piece of text in an existing file. old_text must appear in the file exactly once ' +
    '(do NOT include the line numbers shown by read_file). Include 2-4 surrounding lines of context so the ' +
    'match is unique. Set replace_all=true to change every occurrence. Indentation differences are tolerated.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to modify, relative to the workspace root.' },
      old_text: { type: 'string', description: 'Existing text to find and replace.' },
      new_text: { type: 'string', description: 'Replacement text. Use "" to delete the matched text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique one.' },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  risk: 'medium',

  summarize: (args) => {
    const oldText = str(args, 'old_text');
    const newText = str(args, 'new_text');
    const first = oldText.split('\n')[0]?.trim().slice(0, 60) ?? '';
    return `${str(args, 'path')} — "${first}${oldText.length > 60 ? '…' : ''}" → "${newText
      .split('\n')[0]
      ?.trim()
      .slice(0, 40) ?? ''}${newText.length > 40 ? '…' : ''}"`;
  },

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const target = str(args, 'path');
    const oldText = str(args, 'old_text');
    const newText = str(args, 'new_text');
    const replaceAll = bool(args, 'replace_all', false);

    if (!target) return fail('edit_file requires a "path".');
    if (args.old_text === undefined || args.old_text === null) {
      return fail('edit_file requires "old_text" (the exact text currently in the file).');
    }
    if (args.new_text === undefined || args.new_text === null) {
      return fail('edit_file requires "new_text" (use "" to delete).');
    }
    if (oldText === newText) return fail('old_text and new_text are identical — nothing to do.');

    const checked = checkPath(ctx.workspace, target);
    if (!checked.ok) return fail(checked.error ?? 'Bad path.');

    let original: string;
    try {
      original = await readFile(checked.abs, 'utf8');
    } catch {
      return fail(
        `Cannot read ${checked.rel} — edit_file only works on existing files. Use write_file to create it.`,
      );
    }

    const verdict = await ctx.permissions.check({
      tool: this.name,
      summary: this.summarize(args),
      risk: this.risk,
      path: checked.rel,
      sensitivePath: checked.sensitive,
    });
    if (!verdict.allowed) return fail(`Not allowed to edit ${checked.rel}: ${verdict.reason}`);

    const lines = original.split('\n');
    const needle = oldText.replace(/\r\n/g, '\n').split('\n');
    if (needle.length > 1 && needle[needle.length - 1] === '') needle.pop();

    const exactHits = findExact(lines, needle);

    let updated: string;
    let kind: 'exact' | 'fuzzy';

    if (exactHits.length > 1 && !replaceAll) {
      return fail(
        `old_text matches ${exactHits.length} places in ${checked.rel} (lines ${exactHits
          .slice(0, 6)
          .map((i) => i + 1)
          .join(', ')}). Add more surrounding lines to make it unique, or set replace_all=true.`,
      );
    }

    if (exactHits.length >= 1 && replaceAll) {
      updated = lines.join('\n').split(oldText.replace(/\r\n/g, '\n')).join(newText);
      kind = 'exact';
    } else if (exactHits.length === 1) {
      const start = exactHits[0] as number;
      // '' means "delete these lines", not "insert a blank line".
      const replacement = newText === '' ? [] : newText.split('\n');
      const next = [...lines.slice(0, start), ...replacement, ...lines.slice(start + needle.length)];
      updated = next.join('\n');
      kind = 'exact';
    } else {
      const fuzzy = findFuzzy(lines, needle);
      if (!fuzzy) {
        const hint = bestGuess(lines, needle);
        return fail(
          [
            `old_text was not found in ${checked.rel}.`,
            'Re-read the file and copy the text exactly (without line numbers).',
            hint,
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }
      // The model matched loosely, so its indentation is probably wrong.
      // Re-anchor the replacement on the file's own indent, keeping the
      // relative indentation between the new lines intact.
      const originalIndent = (lines[fuzzy.startLine] ?? '').match(/^[ \t]*/)?.[0] ?? '';
      const newLines = newText === '' ? [] : newText.split('\n');
      const firstNewIndent = (newLines[0] ?? '').match(/^[ \t]*/)?.[0] ?? '';
      const adjusted =
        firstNewIndent === originalIndent ? newLines : reindent(newLines, originalIndent);

      updated = [
        ...lines.slice(0, fuzzy.startLine),
        ...adjusted,
        ...lines.slice(fuzzy.endLine),
      ].join('\n');
      kind = 'fuzzy';
    }

    if (updated === original) {
      return fail(`Edit produced no change in ${checked.rel}.`);
    }

    await writeFile(checked.abs, updated, 'utf8');

    const diff = renderDiff(diffLines(original, updated));
    const display = diff.length > 4000 ? `${diff.slice(0, 4000)}\n…` : diff;
    ctx.ui.toolDetail(display.split('\n').slice(0, 40).join('\n'));

    return ok(
      `Edited ${checked.rel}${kind === 'fuzzy' ? ' (matched with indentation tolerance)' : ''}.`,
      { display, data: { path: checked.rel, kind } },
    );
  },
};
