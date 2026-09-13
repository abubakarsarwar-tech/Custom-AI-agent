import { repairToolCalls } from './repair.js';
import {
  nextCallId,
  type GenerateOptions,
  type LLMProvider,
  type Message,
  type StreamEvent,
  type ToolCall,
  type ToolSpec,
} from './types.js';

export interface MockTurn {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Emit the tool call as raw JSON *inside* the text, to exercise the repair path. */
  asTextJson?: boolean;
}

export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  private index = 0;
  private readonly turns: MockTurn[];
  private readonly chunkSize: number;
  private readonly delayMs: number;

  constructor(
    turns: MockTurn[],
    opts: { chunkSize?: number; delayMs?: number; loop?: boolean } = {},
  ) {
    this.turns = turns;
    this.chunkSize = opts.chunkSize ?? 12;
    this.delayMs = opts.delayMs ?? 0;
    this.loop = opts.loop ?? false;
  }

  /** Replay from the start instead of running out. Used by `lca serve --provider mock`. */
  private readonly loop: boolean;

  async *stream(
    messages: Message[],
    tools: ToolSpec[],
    opts: GenerateOptions = {},
  ): AsyncGenerator<StreamEvent> {
    const t0 = Date.now();
    if (this.loop && this.turns.length > 0) this.index %= this.turns.length;
    const turn: MockTurn =
      this.turns[this.index] ?? { text: '(mock provider ran out of scripted turns)' };
    this.index += 1;
    const allowed = new Set(tools.map((t) => t.function.name));

    let text = turn.text ?? '';
    let toolCalls: ToolCall[] = (turn.toolCalls ?? [])
      .filter((tc) => allowed.has(tc.name))
      .map((tc) => ({ id: nextCallId(), name: tc.name, arguments: tc.arguments }));

    // Simulate a weak local model that prints JSON instead of calling tools.
    if (turn.asTextJson && turn.toolCalls?.length) {
      const first = turn.toolCalls[0];
      if (first) {
        text = `${text}\n\`\`\`json\n${JSON.stringify({ name: first.name, arguments: first.arguments }, null, 2)}\n\`\`\``;
      }
      toolCalls = [];
    }

    for (let i = 0; i < text.length; i += this.chunkSize) {
      if (opts.signal?.aborted) {
        yield { type: 'error', error: 'Aborted.' };
        return;
      }
      const piece = text.slice(i, i + this.chunkSize);
      yield { type: 'delta', text: piece };
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    }

    // Run the same text-based recovery the real provider uses.
    if (toolCalls.length === 0 && text.includes('{')) {
      // repair path is imported statically at the top
      const repaired = repairToolCalls(text, allowed);
      if (repaired.toolCalls.length > 0) {
        toolCalls = repaired.toolCalls;
        text = repaired.cleanedText;
      }
    }

    if (toolCalls.length > 0) yield { type: 'tool_calls', toolCalls };

    const promptChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    yield {
      type: 'done',
      text,
      toolCalls,
      usage: {
        promptTokens: Math.ceil(promptChars / 4),
        completionTokens: Math.ceil((text ?? '').length / 4),
        durationMs: Date.now() - t0,
      },
    };
  }
}

/**
 * The scripted run used by `npm run demo` and the end-to-end test.
 * Proves the loop works with no model installed at all.
 */
export function demoScript(fileName = 'hello.txt'): MockTurn[] {
  return [
    {
      text: 'I will create the file, then read it back to verify.',
      toolCalls: [
        {
          name: 'write_file',
          arguments: { path: fileName, content: 'it works\nbuilt by local-code-agent\n' },
        },
      ],
    },
    {
      text: '',
      toolCalls: [{ name: 'read_file', arguments: { path: fileName } }],
    },
    {
      text: `Done. \`${fileName}\` now exists with the content you asked for:\n\n    it works\n    built by local-code-agent\n\nI verified it by reading the file back from disk.`,
    },
  ];
}

/** A script whose tool call arrives as prose JSON, to test the repair path. */
export function sloppyScript(fileName = 'sloppy.txt'): MockTurn[] {
  return [
    {
      text: 'Sure, let me write that file for you.',
      asTextJson: true,
      toolCalls: [{ name: 'write_file', arguments: { path: fileName, content: 'recovered\n' } }],
    },
    { text: 'Finished. The tool call was recovered from plain text.' },
  ];
}

/**
 * A scripted tour of the web UI for `lca serve --provider mock`.
 *
 * Deliberately touches every part of the browser interface: the plan panel,
 * tool cards, the permission dialog (write_file is gated in "ask" mode), the
 * memory panel, streaming markdown, and the stats line. Loops, so you can keep
 * sending messages and watch it work again.
 */
export function webScript(): MockTurn[] {
  return [
    {
      text: 'Let me plan this out, then look at what is already here.',
      toolCalls: [
        {
          name: 'todo_write',
          arguments: {
            todos: [
              { content: 'Inspect the workspace', status: 'in_progress', priority: 'high' },
              { content: 'Write a small demo file', status: 'pending', priority: 'high' },
              { content: 'Verify it by reading it back', status: 'pending', priority: 'medium' },
              { content: 'Remember the project convention', status: 'pending', priority: 'low' },
            ],
          },
        },
        { name: 'list_dir', arguments: { path: '.' } },
      ],
    },
    {
      text: 'Now I will create the file. In "ask" mode this pops an approval in your browser.',
      toolCalls: [
        {
          name: 'write_file',
          arguments: {
            path: 'demo-from-browser.txt',
            content: 'written by LCA through the web UI\n100% local, zero cloud calls\n',
          },
        },
      ],
    },
    {
      text: '',
      toolCalls: [
        { name: 'read_file', arguments: { path: 'demo-from-browser.txt' } },
        {
          name: 'remember',
          arguments: {
            text: 'This project uses the LCA web UI demo file demo-from-browser.txt.',
            tags: ['web', 'demo'],
          },
        },
      ],
    },
    {
      text: '',
      toolCalls: [
        {
          name: 'todo_write',
          arguments: {
            todos: [
              { content: 'Inspect the workspace', status: 'completed' },
              { content: 'Write a small demo file', status: 'completed' },
              { content: 'Verify it by reading it back', status: 'completed' },
              { content: 'Remember the project convention', status: 'completed' },
            ],
          },
        },
      ],
    },
    {
      text: `Done. Here is what happened:

**1. Planned** the work in the panel on the left, then kept it updated as I went.
**2. Wrote** \`demo-from-browser.txt\` — you approved it in the permission dialog.
**3. Verified** by reading the file back from disk:

\`\`\`
written by LCA through the web UI
100% local, zero cloud calls
\`\`\`

**4. Remembered** a fact about this project, so a later session starts out smarter.

Every step ran on your machine. Nothing was sent anywhere.

- Try the 👍 / 👎 buttons under this message — they vote on what was recalled.
- Click a tool card above to see its raw output.
- Press **Stop** mid-turn to interrupt, or switch to *readonly* mode below.`,
    },
  ];
}
