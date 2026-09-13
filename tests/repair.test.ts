import { describe, expect, it } from 'vitest';
import { lenientJsonParse, repairToolCalls } from '../src/llm/repair.js';

const allowed = new Set(['read_file', 'write_file', 'edit_file', 'bash', 'search']);

describe('repairToolCalls', () => {
  it('recovers a fenced JSON tool call from prose', () => {
    const text = [
      'Sure! I will create that file now.',
      '```json',
      '{"name": "write_file", "arguments": {"path": "a.txt", "content": "hello"}}',
      '```',
    ].join('\n');

    const { toolCalls, cleanedText } = repairToolCalls(text, allowed);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe('write_file');
    expect(toolCalls[0]?.arguments).toEqual({ path: 'a.txt', content: 'hello' });
    expect(toolCalls[0]?.repaired).toBe(true);
    expect(cleanedText).toContain('Sure!');
    expect(cleanedText).not.toContain('write_file');
  });

  it('recovers a bare JSON object with no fences', () => {
    const text = 'Let me look. {"tool": "read_file", "args": {"path": "src/x.ts"}} done';
    const { toolCalls } = repairToolCalls(text, allowed);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe('read_file');
    expect(toolCalls[0]?.arguments.path).toBe('src/x.ts');
  });

  it('handles arguments passed as a JSON string', () => {
    const text = '{"name":"bash","arguments":"{\\"command\\":\\"git status\\"}"}';
    const { toolCalls } = repairToolCalls(text, allowed);
    expect(toolCalls[0]?.arguments.command).toBe('git status');
  });

  it('ignores JSON that is not a known tool', () => {
    const text = 'Here is an example config: {"host": "localhost", "port": 8080}';
    const { toolCalls, cleanedText } = repairToolCalls(text, allowed);
    expect(toolCalls).toHaveLength(0);
    expect(cleanedText).toBe(text);
  });

  it('ignores braces inside strings', () => {
    const text = 'The template literal is `const x = { a: 1 }` — nothing to call here.';
    const { toolCalls } = repairToolCalls(text, allowed);
    expect(toolCalls).toHaveLength(0);
  });

  it('returns nothing for plain prose', () => {
    expect(repairToolCalls('All done, the tests pass.', allowed).toolCalls).toHaveLength(0);
  });
});

describe('lenientJsonParse', () => {
  it('parses valid JSON', () => {
    expect(lenientJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('salvages trailing commas', () => {
    expect(lenientJsonParse('{"a":1,}')).toEqual({ a: 1 });
  });

  it('salvages single quotes', () => {
    expect(lenientJsonParse("{'a':'b'}")).toEqual({ a: 'b' });
  });

  it('salvages unquoted keys', () => {
    expect(lenientJsonParse('{a: "b"}')).toEqual({ a: 'b' });
  });

  it('gives up on nonsense', () => {
    expect(lenientJsonParse('not json at all')).toBeNull();
  });
});
