import { readFile, stat } from 'node:fs/promises';
import { checkPath, looksBinary, truncate } from '../safety/paths.js';
import { fail, int, ok, str, type Tool, type ToolContext, type ToolResult } from './types.js';

const MAX_LINES_DEFAULT = 2000;

/** startAt is the 1-based number of the FIRST line in `lines`. */
function numberLines(lines: string[], startAt: number): string {
  const width = String(Math.max(startAt, startAt + lines.length - 1)).length;
  return lines
    .map((text, i) => `${String(startAt + i).padStart(width, ' ')}\t${text}`)
    .join('\n');
}

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a text file from the workspace and return it with line numbers (cat -n style). ' +
    'The line numbers are NOT part of the file — never include them in old_text/new_text when editing. ' +
    'Use offset/limit for large files. ALWAYS read a file before editing it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      offset: { type: 'number', description: '1-based line number to start reading from.' },
      limit: { type: 'number', description: `Max lines to return (default ${MAX_LINES_DEFAULT}).` },
    },
    required: ['path'],
  },
  risk: 'low',

  summarize: (args) => str(args, 'path'),

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const target = str(args, 'path');
    const checked = checkPath(ctx.workspace, target);
    if (!checked.ok) return fail(checked.error ?? 'Bad path.');

    let info;
    try {
      info = await stat(checked.abs);
    } catch {
      return fail(
        `No such file: ${checked.rel}. Use list_dir or search to find the right path.`,
      );
    }
    if (info.isDirectory()) {
      return fail(`${checked.rel} is a directory. Use list_dir instead.`);
    }
    if (info.size > ctx.config.maxFileBytes) {
      return fail(
        `${checked.rel} is ${(info.size / 1024).toFixed(0)} KB, above the ${
          ctx.config.maxFileBytes
        } byte limit. Read it in slices with offset/limit, or use search to find the part you need.`,
      );
    }

    const buf = await readFile(checked.abs);
    if (looksBinary(buf)) {
      return fail(`${checked.rel} looks like a binary file (${info.size} bytes); cannot display it.`);
    }

    const raw = buf.toString('utf8');
    const allLines = raw.split('\n');
    if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop();

    const offset = Math.max(1, int(args, 'offset', 1));
    const limit = Math.max(1, int(args, 'limit', MAX_LINES_DEFAULT));
    const slice = allLines.slice(offset - 1, offset - 1 + limit);
    const omittedBefore = offset - 1;
    const omittedAfter = Math.max(0, allLines.length - (offset - 1 + slice.length));

    let body = numberLines(slice, offset);
    body = truncate(body, ctx.config.maxOutputChars, 'file');

    const header = `${checked.rel} · ${allLines.length} lines · ${(info.size / 1024).toFixed(1)} KB`;
    const notes: string[] = [];
    if (omittedBefore > 0) notes.push(`skipped ${omittedBefore} lines before (use offset)`);
    if (omittedAfter > 0) notes.push(`${omittedAfter} more lines after (use offset=${offset + slice.length})`);

    return ok([header, notes.length > 0 ? `(${notes.join('; ')})` : '', body].filter(Boolean).join('\n'), {
      data: { path: checked.rel, lines: allLines.length, bytes: info.size },
    });
  },
};
