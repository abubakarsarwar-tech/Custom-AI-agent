import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { checkPath, looksBinary } from '../safety/paths.js';

const MENTION_RE = /(?:^|\s)@([A-Za-z0-9_./\-+@]+)/g;

export interface MentionResult {
  text: string;
  attached: Array<{ rel: string; lines: number }>;
  errors: string[];
}

/**
 * `@src/index.ts fix the bug` — the Claude Code / Cursor style file mention.
 * Attaching a file directly is far cheaper than making a 7B model spend a tool
 * call discovering it.
 */
export async function expandMentions(
  input: string,
  workspace: string,
  maxBytes = 60_000,
): Promise<MentionResult> {
  const found: string[] = [];
  for (const match of input.matchAll(MENTION_RE)) {
    const candidate = match[1];
    if (candidate) found.push(candidate);
  }

  const blocks: string[] = [];
  const attached: MentionResult['attached'] = [];
  const errors: string[] = [];

  for (const rel of [...new Set(found)]) {
    const checked = checkPath(workspace, rel);
    if (!checked.ok) {
      errors.push(`@${rel}: outside the workspace`);
      continue;
    }
    try {
      const st = await stat(checked.abs);
      if (st.isDirectory()) {
        errors.push(`@${rel}: is a directory, not a file`);
        continue;
      }
      if (st.size > maxBytes) {
        errors.push(`@${rel}: ${(st.size / 1024).toFixed(0)} KB is too large to attach`);
        continue;
      }
      const buf = await readFile(checked.abs);
      if (looksBinary(buf)) {
        errors.push(`@${rel}: binary file`);
        continue;
      }
      const ext = path.extname(checked.rel).slice(1) || 'text';
      const body = buf.toString('utf8');
      blocks.push(`<file path="${checked.rel}">\n\`\`\`${ext}\n${body}\n\`\`\`\n</file>`);
      attached.push({ rel: checked.rel, lines: body.split('\n').length });
    } catch {
      errors.push(`@${rel}: could not be read`);
    }
  }

  // The @mentions stay in the prompt (they tell the model which file the user
  // meant); the file bodies are appended as clearly delimited blocks.
  const text = blocks.length > 0 ? `${input.trim()}\n\n${blocks.join('\n\n')}` : input.trim();
  return { text, attached, errors };
}
