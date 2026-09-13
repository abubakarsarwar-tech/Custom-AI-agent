import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkPath } from '../safety/paths.js';
import { diffLines, renderDiff } from '../util/diff.js';
import { fail, ok, str, type Tool, type ToolContext, type ToolResult } from './types.js';

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Write a complete file, creating parent directories as needed. Overwrites any existing content. ' +
    'Use this for NEW files or full rewrites; use edit_file for targeted changes to an existing file. ' +
    'Always write the full, final, working content — never placeholders, never "rest of code here", never TODO stubs.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      content: { type: 'string', description: 'Full file content to write.' },
    },
    required: ['path', 'content'],
  },
  risk: 'medium',

  summarize: (args) => {
    const content = str(args, 'content');
    return `${str(args, 'path')} (${content.split('\n').length} lines, ${content.length} chars)`;
  },

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const target = str(args, 'path');
    const content = str(args, 'content');

    if (!target) return fail('write_file requires a "path".');
    if (!content) return fail('write_file requires non-empty "content".');

    const checked = checkPath(ctx.workspace, target);
    if (!checked.ok) return fail(checked.error ?? 'Bad path.');

    const verdict = await ctx.permissions.check({
      tool: this.name,
      summary: this.summarize(args),
      risk: this.risk,
      path: checked.rel,
      sensitivePath: checked.sensitive,
    });
    if (!verdict.allowed) return fail(`Not allowed to write ${checked.rel}: ${verdict.reason}`);

    let before: string | null = null;
    try {
      before = await readFile(checked.abs, 'utf8');
    } catch {
      before = null;
    }

    await mkdir(path.dirname(checked.abs), { recursive: true });
    await writeFile(checked.abs, content, 'utf8');

    const lines = content.split('\n').length;
    let display = '';
    if (before !== null) {
      const diff = renderDiff(diffLines(before, content));
      display = diff.length > 4000 ? `${diff.slice(0, 4000)}\n…` : diff;
    }

    ctx.ui.toolDetail(
      before === null
        ? `created ${checked.rel} (${lines} lines)`
        : `updated ${checked.rel} (${before.split('\n').length} → ${lines} lines)`,
    );

    return ok(
      before === null
        ? `Created ${checked.rel} with ${lines} lines.`
        : `Updated ${checked.rel}: ${before.split('\n').length} → ${lines} lines.`,
      { display, data: { path: checked.rel, created: before === null, lines } },
    );
  },
};
