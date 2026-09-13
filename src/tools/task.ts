import { fail, ok, str, type Tool, type ToolContext, type ToolResult } from './types.js';

/**
 * Delegation. The point is context isolation, not parallelism: a laptop runs one
 * local model at a time, so sub-agents are sequential. What they buy you is that
 * twenty file reads happen in *their* window and only a short report comes back
 * into yours.
 */
export const taskTool: Tool = {
  name: 'task',
  description:
    'Delegate a self-contained job to a sub-agent that gets its OWN fresh context window and returns ' +
    'only a short report. Use it when answering would mean reading many files or running many searches ' +
    '(e.g. "find every place the session token is validated and report the files and line numbers"), or ' +
    'for an independent question whose workings you do not need to keep. ' +
    'Do NOT use it for: anything that needs this conversation\'s context, a single file you could just ' +
    'read, or edits the user should watch you make — do those yourself so the diff is visible. ' +
    'kind="explore" (default) is read-only and reports findings; kind="work" may change files and each ' +
    'change still asks for permission. Write the prompt as a complete brief: the sub-agent cannot see ' +
    'this conversation and cannot ask you anything. One job per call; they run one at a time.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'The complete brief. Must stand alone: what to find or do, where to look, and exactly what the report should contain.',
      },
      kind: {
        type: 'string',
        enum: ['explore', 'work'],
        description: 'explore = read-only research (default). work = may edit files.',
      },
    },
    required: ['prompt'],
  },
  // The delegation itself changes nothing; any write the sub-agent attempts goes
  // through the permission gate individually, exactly like a direct call.
  risk: 'low',

  summarize: (args) => {
    const kind = str(args, 'kind', 'explore') === 'work' ? 'work' : 'explore';
    return `${kind}: ${str(args, 'prompt').replace(/\s+/g, ' ').slice(0, 110)}`;
  },

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.subagent) return fail('Sub-agents are disabled in this session (LCA_SUBAGENTS=false).');

    const prompt = str(args, 'prompt').replace(/\s+/g, ' ').trim();
    if (!prompt) {
      return fail('task requires a "prompt": the complete brief for the sub-agent.');
    }
    if (prompt.length < 15) {
      return fail(
        'That brief is too vague to delegate. A sub-agent cannot see this conversation, so spell out ' +
          'what to look for, where, and what the report must contain.',
      );
    }
    const kind = str(args, 'kind', 'explore') === 'work' ? 'work' : 'explore';

    ctx.ui.toolDetail(`spawning ${kind} sub-agent with its own context`);
    const res = await ctx.subagent({ prompt, kind, signal: ctx.signal });

    const header = [
      `[sub-agent report · ${res.kind}`,
      `${res.steps} steps`,
      `${res.toolCalls} tool calls`,
      `in ${res.tokens.prompt} / out ${res.tokens.completion} tok`,
      `${(res.ms / 1000).toFixed(1)}s]`,
    ].join(' · ');

    const body = `${header}\n${res.report}`;
    // `display` is what the terminal and the browser card show inline: a headline
    // plus the first lines of the report, so a delegation is never a black box.
    const display = [header, ...res.report.split('\n').slice(0, 6)].join('\n').slice(0, 600);

    // Everything the parent learns is in `body` — the child's reads and reasoning
    // stayed in the child's window, which is the entire point.
    return ok(body, {
      display,
      data: {
        kind: res.kind,
        steps: res.steps,
        toolCalls: res.toolCalls,
        truncated: res.truncated,
        hitMaxSteps: res.hitMaxSteps,
        aborted: res.aborted,
        ms: res.ms,
      },
    });
  },
};
