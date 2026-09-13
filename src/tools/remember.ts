import { fail, ok, str, type Tool, type ToolContext, type ToolResult } from './types.js';

export const rememberTool: Tool = {
  name: 'remember',
  description:
    'Save a durable fact about THIS project so future sessions start out smarter, or search what is ' +
    'already remembered. Save with {text, tags?}: a correction the user gave you, a project convention, ' +
    'a command that works, or a gotcha you hit. One fact per call, phrased as a rule ("Use pnpm, never npm"). ' +
    'Search with {query} instead of text. Do NOT save one-off task details or anything secret.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The fact to remember, as a short imperative rule.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Keywords for recall, e.g. ["testing","pnpm"]' },
      query: { type: 'string', description: 'Search remembered facts instead of saving one.' },
      forget: { type: 'string', description: 'Id of a remembered fact to delete.' },
    },
    required: [],
  },
  risk: 'low',

  summarize: (args) => {
    const q = str(args, 'query');
    const f = str(args, 'forget');
    if (f) return `forget ${f}`;
    if (q) return `search "${q}"`;
    return `"${str(args, 'text').slice(0, 90)}"`;
  },

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const store = ctx.memory;
    if (!store) return fail('Memory is disabled in this session.');

    const forget = str(args, 'forget').trim();
    if (forget) {
      const removed = await store.remove(forget);
      return removed ? ok(`Forgot ${forget}.`) : fail(`No memory with id "${forget}".`);
    }

    const query = str(args, 'query').trim();
    if (query) {
      const hits = store.relevant(query, 10, 1);
      if (hits.length === 0) {
        return ok(`Nothing remembered about "${query}" yet. (${store.count} facts stored in total.)`);
      }
      return ok(
        `Remembered (${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}"):\n` +
          hits.map((h) => `- [${h.lesson.id}] ${h.lesson.text} (score ${h.lesson.score})`).join('\n'),
      );
    }

    const text = str(args, 'text').trim();
    if (!text) {
      return fail('remember needs either "text" (to save), "query" (to search), or "forget" (an id).');
    }
    if (text.length > 500) {
      return fail('Keep a memory under 500 characters — it has to fit in a prompt. Split it into separate facts.');
    }
    if (/password|secret|api[_ -]?key|token\s*[:=]/i.test(text)) {
      return fail('Refusing to store something that looks like a credential. Never put secrets in memory.');
    }

    const rawTags = args.tags;
    const tags = Array.isArray(rawTags)
      ? rawTags.map((t) => String(t)).slice(0, 6)
      : str(args, 'tags')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 6);

    const lesson = await store.add(text, { tags, source: 'agent' });
    ctx.ui.log(`remembered: ${lesson.text}`);
    return ok(
      `Remembered (${lesson.id}): "${lesson.text}"\nIt will be recalled automatically in future sessions when relevant.`,
      { data: { id: lesson.id, tags: lesson.tags } },
    );
  },
};
