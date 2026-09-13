import { describe, expect, it } from 'vitest';
import { compactHistory } from '../src/agent/compact.js';
import { estimateMessages } from '../src/agent/tokens.js';
import { diffLines, renderDiff } from '../src/util/diff.js';
import { normalizeArgs } from '../src/tools/arg-aliases.js';
import { buildSystemPrompt } from '../src/agent/context.js';
import type { Message } from '../src/llm/types.js';

function bigHistory(pairs: number): Message[] {
  const msgs: Message[] = [{ role: 'system', content: 'You are the agent.' }];
  msgs.push({ role: 'user', content: 'Please refactor the whole project for me.' });
  for (let i = 0; i < pairs; i += 1) {
    msgs.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `c${i}`, name: 'read_file', arguments: { path: `src/file${i}.ts` } }],
    });
    msgs.push({ role: 'tool', tool_name: 'read_file', content: 'x'.repeat(900) });
  }
  return msgs;
}

describe('compactHistory', () => {
  it('leaves a small conversation alone', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const res = compactHistory(msgs, { budgetTokens: 100000 });
    expect(res.compacted).toBe(false);
    expect(res.messages).toEqual(msgs);
  });

  it('summarises old turns and keeps recent ones verbatim', () => {
    const msgs = bigHistory(40);
    const res = compactHistory(msgs, { budgetTokens: 1200, keepRecent: 6 });
    expect(res.compacted).toBe(true);
    expect(res.afterTokens).toBeLessThan(res.beforeTokens);
    expect(res.messages[0]?.role).toBe('system');
    expect(res.messages.some((m) => m.content.includes('Context compacted'))).toBe(true);
    expect(res.messages.some((m) => m.content.includes('Files read'))).toBe(true);
    expect(res.messages.some((m) => /src\/file\d+\.ts/.test(m.content))).toBe(true);
  });

  it('never starts the recent slice with an orphan tool result', () => {
    const msgs = bigHistory(30);
    const res = compactHistory(msgs, { budgetTokens: 800, keepRecent: 5 });
    const afterSummary = res.messages.findIndex((m) => m.content.includes('Context compacted'));
    const next = res.messages[afterSummary + 1];
    expect(next?.role).not.toBe('tool');
  });

  it('keeps the system prompt intact', () => {
    const res = compactHistory(bigHistory(30), { budgetTokens: 600 });
    expect(res.messages.filter((m) => m.role === 'system')).toHaveLength(1);
  });
});

describe('estimateMessages', () => {
  it('grows with content', () => {
    const small = estimateMessages([{ role: 'user', content: 'hi' }]);
    const large = estimateMessages([{ role: 'user', content: 'x'.repeat(4000) }]);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(1000);
  });
});

describe('diff', () => {
  it('marks added and removed lines', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc');
    const text = renderDiff(d);
    expect(text).toContain('- b');
    expect(text).toContain('+ B');
  });

  it('shows pure additions', () => {
    const text = renderDiff(diffLines('a\nc', 'a\nb\nc'));
    expect(text).toContain('+ b');
  });

  it('handles identical input', () => {
    expect(diffLines('same\n', 'same\n').every((l) => l.type === 'ctx')).toBe(true);
  });
});

describe('normalizeArgs', () => {
  it('maps file_path -> path and text -> content', () => {
    const out = normalizeArgs('write_file', { file_path: 'a.ts', text: 'code' });
    expect(out.path).toBe('a.ts');
    expect(out.content).toBe('code');
  });

  it('does not clobber a correct canonical key', () => {
    const out = normalizeArgs('edit_file', { path: 'real.ts', file: 'ignored.ts' });
    expect(out.path).toBe('real.ts');
  });

  it('coerces stringy booleans and numbers', () => {
    const out = normalizeArgs('edit_file', { replace_all: 'true', path: 'a' });
    expect(out.replace_all).toBe(true);
    const out2 = normalizeArgs('read_file', { offset: '12', path: 'a' });
    expect(out2.offset).toBe(12);
  });

  it('maps cmd -> command', () => {
    expect(normalizeArgs('bash', { cmd: 'ls' }).command).toBe('ls');
  });

  it('leaves unknown tools untouched', () => {
    expect(normalizeArgs('mystery', { foo: 1 })).toEqual({ foo: 1 });
  });
});

describe('system prompt', () => {
  it('contains the rules that make it an agent, not a chatbot', () => {
    const p = buildSystemPrompt({
      modelName: 'test-model',
      repoContext: 'Workspace: /tmp/x',
      customInstructions: '',
      toolNames: ['read_file', 'write_file'],
      permissionMode: 'ask',
    });
    expect(p).toContain('test-model');
    expect(p).toContain('read_file, write_file');
    expect(p).toMatch(/Read before you edit/i);
    expect(p).toMatch(/No placeholders/i);
    expect(p).toMatch(/Workspace: \/tmp\/x/);
  });

  it('injects project rules from AGENTS.md', () => {
    const p = buildSystemPrompt({
      modelName: 'm',
      repoContext: 'x',
      customInstructions: '# Project rules\nAlways run pytest before finishing.',
      toolNames: [],
      permissionMode: 'ask',
    });
    expect(p).toContain('Always run pytest');
  });
});
