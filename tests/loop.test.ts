import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeRuntime, makeSandbox, type Sandbox } from './helpers.js';
import type { MockTurn } from '../src/llm/mock.js';

let box: Sandbox;

beforeEach(async () => {
  box = await makeSandbox();
});
afterEach(async () => {
  await box.cleanup();
});

const ac = () => new AbortController().signal;

describe('agent loop', () => {
  it('runs think -> tool -> observe -> answer end to end', async () => {
    const turns: MockTurn[] = [
      { text: 'Working on it.', toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'one\n' } }] },
      { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
      { text: 'Created a.txt and verified its contents.' },
    ];
    const { rt } = await makeRuntime(box.dir, turns);
    const result = await rt.send('create a.txt', ac());

    expect(result.steps).toBe(3);
    expect(result.toolCalls).toBe(2);
    expect(result.answer).toContain('Created a.txt');
    expect(await box.read('a.txt')).toBe('one\n');
    expect(result.error).toBeUndefined();
  });

  it('recovers a tool call the model printed as prose JSON', async () => {
    const turns: MockTurn[] = [
      {
        text: 'Let me write that file.',
        asTextJson: true,
        toolCalls: [{ name: 'write_file', arguments: { path: 'sloppy.txt', content: 'recovered\n' } }],
      },
      { text: 'Done.' },
    ];
    const { rt } = await makeRuntime(box.dir, turns);
    const result = await rt.send('write sloppy.txt', ac());

    expect(await box.read('sloppy.txt')).toBe('recovered\n');
    expect(result.answer).toBe('Done.');
  });

  it('translates wrong argument names via the alias table', async () => {
    const turns: MockTurn[] = [
      { toolCalls: [{ name: 'write_file', arguments: { file_path: 'aliased.txt', text: 'ok\n' } }] },
      { text: 'wrote it' },
    ];
    const { rt } = await makeRuntime(box.dir, turns);
    await rt.send('write aliased.txt', ac());
    expect(await box.read('aliased.txt')).toBe('ok\n');
  });

  it('feeds tool errors back so the model can retry', async () => {
    const turns: MockTurn[] = [
      { toolCalls: [{ name: 'read_file', arguments: { path: 'ghost.txt' } }] },
      { toolCalls: [{ name: 'write_file', arguments: { path: 'ghost.txt', content: 'now here\n' } }] },
      { text: 'It was missing, so I created it.' },
    ];
    const { rt } = await makeRuntime(box.dir, turns);
    const result = await rt.send('fix ghost.txt', ac());

    const toolMsg = rt.messages.find((m) => m.role === 'tool' && m.content.includes('No such file'));
    expect(toolMsg).toBeTruthy();
    expect(result.answer).toContain('created it');
    expect(await box.read('ghost.txt')).toBe('now here\n');
  });

  it('stops a model stuck in a repeat loop', async () => {
    const same: MockTurn = {
      toolCalls: [{ name: 'read_file', arguments: { path: 'ghost.txt' } }],
    };
    const turns = [same, same, same, same, same, same, { text: 'giving up' }];
    const { rt } = await makeRuntime(box.dir, turns, { maxSteps: 12 });
    const result = await rt.send('loop forever', ac());

    const breaks = rt.messages.filter((m) => m.role === 'tool' && m.content.includes('identical call'));
    expect(breaks.length).toBeGreaterThan(0);
    expect(result.toolCalls).toBeLessThan(12);
  });

  it('denies a write in readonly mode and tells the model why', async () => {
    const turns: MockTurn[] = [
      { toolCalls: [{ name: 'write_file', arguments: { path: 'blocked.txt', content: 'x' } }] },
      { text: 'I am not allowed to write in this mode.' },
    ];
    const { rt } = await makeRuntime(box.dir, turns, { permissionMode: 'readonly' });
    const result = await rt.send('write blocked.txt', ac());

    expect(await box.exists('blocked.txt')).toBe(false);
    expect(rt.messages.some((m) => m.role === 'tool' && /Read-only mode/.test(m.content))).toBe(true);
    expect(result.answer).toContain('not allowed');
  });

  it('blocks a catastrophic shell command', async () => {
    const turns: MockTurn[] = [
      { toolCalls: [{ name: 'bash', arguments: { command: 'rm -rf /' } }] },
      { text: 'refused' },
    ];
    const { rt } = await makeRuntime(box.dir, turns, { permissionMode: 'auto' });
    await rt.send('nuke it', ac());
    expect(rt.messages.some((m) => m.role === 'tool' && /Blocked/.test(m.content))).toBe(true);
  });

  it('runs an approved shell command and returns its output', async () => {
    await box.write('script.txt', 'hello from bash\n');
    const turns: MockTurn[] = [
      { toolCalls: [{ name: 'bash', arguments: { command: 'cat script.txt' } }] },
      { text: 'ran it' },
    ];
    const { rt } = await makeRuntime(box.dir, turns);
    await rt.send('show script.txt', ac());
    const out = rt.messages.find((m) => m.role === 'tool' && m.tool_name === 'bash');
    expect(out?.content).toContain('hello from bash');
    expect(out?.content).toContain('exit code: 0');
  });

  it('reports a failing command as an error result', async () => {
    const turns: MockTurn[] = [
      { toolCalls: [{ name: 'bash', arguments: { command: 'exit 3' } }] },
      { text: 'it failed' },
    ];
    const { rt } = await makeRuntime(box.dir, turns);
    await rt.send('run something broken', ac());
    const out = rt.messages.find((m) => m.role === 'tool' && m.tool_name === 'bash');
    expect(out?.content).toContain('exit code: 3');
  });

  it('respects the step limit instead of running forever', async () => {
    const turns: MockTurn[] = Array.from({ length: 10 }, (_, i) => ({
      toolCalls: [{ name: 'bash', arguments: { command: `echo step ${i}` } }],
    }));
    const { rt } = await makeRuntime(box.dir, turns, { maxSteps: 4 });
    const result = await rt.send('go forever', ac());
    expect(result.hitMaxSteps).toBe(true);
    expect(result.steps).toBeLessThanOrEqual(4);
  });

  it('keeps the plan in context on later steps', async () => {
    const turns: MockTurn[] = [
      {
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: [
                { content: 'step one', status: 'in_progress' },
                { content: 'step two', status: 'pending' },
              ],
            },
          },
        ],
      },
      { toolCalls: [{ name: 'bash', arguments: { command: 'echo a' } }] },
      { toolCalls: [{ name: 'bash', arguments: { command: 'echo b' } }] },
      { text: 'all done' },
    ];
    const { rt } = await makeRuntime(box.dir, turns);
    await rt.send('do a two step task', ac());
    expect(rt.session.plan.all()).toHaveLength(2);
    expect(rt.messages.some((m) => m.content.includes('[agent reminder]'))).toBe(true);
  });
});
