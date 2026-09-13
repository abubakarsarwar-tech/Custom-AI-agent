import type { Message } from '../llm/types.js';
import { estimateMessages } from './tokens.js';

export interface CompactOptions {
  /** Hard ceiling for the whole conversation, in estimated tokens. */
  budgetTokens: number;
  /** Keep at least this many of the most recent messages untouched. */
  keepRecent?: number;
}

export interface CompactResult {
  messages: Message[];
  compacted: boolean;
  dropped: number;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * Local models live with 4k-32k context windows, so an agent that reads ten
 * files hits the ceiling fast. When that happens we replace the OLDEST
 * tool-call/tool-result pairs with a compact action log.
 *
 * Deliberately deterministic (no extra LLM call): a summarisation pass on a 7B
 * model costs seconds and often hallucinates. A factual log of what was
 * touched is both cheaper and more trustworthy.
 */
export function compactHistory(
  messages: Message[],
  opts: CompactOptions,
): CompactResult {
  const beforeTokens = estimateMessages(messages);
  const keepRecent = opts.keepRecent ?? 8;

  if (beforeTokens <= opts.budgetTokens || messages.length <= keepRecent + 2) {
    return { messages, compacted: false, dropped: 0, beforeTokens, afterTokens: beforeTokens };
  }

  const systemHead = messages.filter((m) => m.role === 'system').slice(0, 1);
  const rest = messages.filter((m) => m !== systemHead[0]);

  // Split into "old" (to be summarised) and "recent" (kept verbatim).
  let cut = Math.max(0, rest.length - keepRecent);
  // Never start the recent slice with an orphan tool result.
  while (cut < rest.length && rest[cut]?.role === 'tool') cut += 1;
  if (cut >= rest.length) cut = Math.max(0, rest.length - keepRecent);

  const old = rest.slice(0, cut);
  const recent = rest.slice(cut);

  const log = buildActionLog(old);
  const summary: Message = {
    role: 'user',
    content:
      `[Context compacted to stay inside the ${opts.budgetTokens}-token window. ` +
      `Earlier turns were replaced by this factual log — treat it as ground truth.]\n\n${log}\n\n` +
      'Continue the current task from here. Do not re-do work listed as completed.',
  };

  const out = [...systemHead, summary, ...recent];
  const afterTokens = estimateMessages(out);

  return {
    messages: out,
    compacted: true,
    dropped: old.length,
    beforeTokens,
    afterTokens,
  };
}

function buildActionLog(old: Message[]): string {
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const commands: string[] = [];
  const searches: string[] = [];
  const userAsks: string[] = [];
  const assistantNotes: string[] = [];

  for (const m of old) {
    if (m.role === 'user' && !m.content.startsWith('[Context compacted')) {
      userAsks.push(m.content.replace(/\s+/g, ' ').slice(0, 200));
    }
    if (m.role === 'assistant') {
      for (const tc of m.tool_calls ?? []) {
        const args = tc.arguments as Record<string, unknown>;
        const p = typeof args.path === 'string' ? args.path : '';
        switch (tc.name) {
          case 'read_file':
            if (p) filesRead.add(p);
            break;
          case 'write_file':
          case 'edit_file':
            if (p) filesWritten.add(p);
            break;
          case 'bash':
            if (typeof args.command === 'string') commands.push(args.command.slice(0, 160));
            break;
          case 'search':
            if (typeof args.pattern === 'string') searches.push(args.pattern.slice(0, 80));
            break;
          default:
            break;
        }
      }
      if (m.content && m.content.trim()) {
        assistantNotes.push(m.content.replace(/\s+/g, ' ').trim().slice(0, 180));
      }
    }
  }

  const sections: string[] = [];
  const push = (label: string, items: string[]): void => {
    if (items.length > 0) sections.push(`${label}:\n- ${items.join('\n- ')}`);
  };

  push('User asked', userAsks.slice(-4));
  push('Files read', [...filesRead].slice(-25));
  push('Files created/modified', [...filesWritten].slice(-25));
  push('Commands run', commands.slice(-15));
  push('Searches run', searches.slice(-10));
  push('Conclusions so far', assistantNotes.slice(-3));

  return sections.length > 0 ? sections.join('\n\n') : '(no recorded actions)';
}
