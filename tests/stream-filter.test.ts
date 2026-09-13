import { describe, expect, it } from 'vitest';
import { StreamEcho } from '../src/agent/stream-filter.js';

/** Push a string through the filter in small chunks, like a real stream. */
function simulate(text: string, chunkSize = 5): { shown: string; echo: StreamEcho } {
  const echo = new StreamEcho();
  let shown = '';
  for (let i = 0; i < text.length; i += chunkSize) {
    shown += echo.push(text.slice(i, i + chunkSize));
  }
  return { shown, echo };
}

describe('StreamEcho', () => {
  it('passes ordinary prose straight through', () => {
    const text = 'I fixed the bug in auth.ts and ran the tests. Everything passes now.';
    const { shown, echo } = simulate(text);
    expect(shown + echo.finish()).toBe(text);
  });

  it('hides a fenced JSON tool call', () => {
    const text =
      'Let me write that file.\n```json\n{"name": "write_file", "arguments": {"path": "a.txt"}}\n```\n';
    const { shown, echo } = simulate(text, 3);
    expect(shown).toContain('Let me write that file.');
    expect(shown).not.toContain('write_file');
    expect(shown).not.toContain('arguments');
    expect(echo.isSuppressed).toBe(true);
  });

  it('hides a bare JSON tool call with no fence', () => {
    const text = 'Ok doing it now {"tool": "read_file", "args": {"path": "x"}}';
    const { shown, echo } = simulate(text, 4);
    expect(shown).toContain('Ok doing it now');
    expect(shown).not.toContain('read_file');
    expect(echo.isSuppressed).toBe(true);
  });

  it('keeps prose that arrives after the JSON block', () => {
    const text = 'Before\n{"name": "bash", "arguments": {"command": "ls"}}\nAfter the call.';
    const echo = new StreamEcho();
    let shown = '';
    // whole-string push, then check the tail is still recoverable via full()
    shown += echo.push(text);
    shown += echo.finish();
    expect(shown).toContain('Before');
    expect(shown).not.toContain('bash');
    expect(echo.full()).toBe(text);
  });

  it('revealAll gives the text back when it was not a tool call', () => {
    const text = 'Here is the shape you need:\n{"name": "string", "type": "foo"}\nUse it wisely.';
    const echo = new StreamEcho();
    let shown = '';
    for (let i = 0; i < text.length; i += 6) shown += echo.push(text.slice(i, i + 6));
    expect(echo.isSuppressed).toBe(true);
    shown += echo.revealAll();
    expect(shown).toBe(text);
  });

  it('does not suppress ordinary code fences', () => {
    const text = 'Try this:\n```ts\nconst x = { name: "y" };\n```\n';
    const { shown, echo } = simulate(text, 4);
    expect(echo.isSuppressed).toBe(false);
    expect(shown + echo.finish()).toBe(text);
  });

  it('handles an empty stream', () => {
    const echo = new StreamEcho();
    expect(echo.push('')).toBe('');
    expect(echo.finish()).toBe('');
    expect(echo.full()).toBe('');
  });

  it('works when the whole reply arrives in one chunk', () => {
    const text = 'Answer with no tools at all.';
    const echo = new StreamEcho();
    expect(echo.push(text) + echo.finish()).toBe(text);
  });
});
