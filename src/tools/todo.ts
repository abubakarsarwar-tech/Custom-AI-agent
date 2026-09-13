import type { Todo, TodoStatus } from '../agent/plan.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed', 'blocked'];

function coerceStatus(raw: unknown): TodoStatus {
  const s = String(raw ?? '').toLowerCase().replace(/[\s-]/g, '_');
  if (s === 'done' || s === 'complete' || s === 'finished') return 'completed';
  if (s === 'doing' || s === 'active' || s === 'working') return 'in_progress';
  if (s === 'todo' || s === '') return 'pending';
  return (STATUSES as string[]).includes(s) ? (s as TodoStatus) : 'pending';
}

export const todoTool: Tool = {
  name: 'todo_write',
  description:
    'Create or update your task plan for the current request. Call it first for any task needing more than ' +
    'two or three steps, then keep exactly ONE item in_progress and mark items completed as you finish them. ' +
    'This is how you stay on track across many tool calls.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full plan (this replaces the previous one).',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'A concrete, verb-first task.' },
            status: { type: 'string', enum: STATUSES },
            priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            note: { type: 'string', description: 'Short note, e.g. what you discovered.' },
          },
          required: ['content', 'status'],
        },
      },
      clear: { type: 'boolean', description: 'Pass true to wipe the plan when the task is finished.' },
    },
    required: [],
  },
  risk: 'low',

  summarize: (args) => {
    const list = Array.isArray(args.todos) ? args.todos : [];
    return `${list.length} item(s)`;
  },

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (args.clear === true) {
      ctx.session.plan.clear();
      return ok('Plan cleared.');
    }

    const rawList = args.todos;
    if (!Array.isArray(rawList)) {
      return fail('todo_write needs "todos" as an array of {content, status}.');
    }

    const todos: Todo[] = [];
    for (const item of rawList) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const content = String(rec.content ?? rec.text ?? rec.task ?? '').trim();
      if (!content) continue;
      todos.push({
        content,
        status: coerceStatus(rec.status),
        priority: ['low', 'medium', 'high'].includes(String(rec.priority))
          ? (String(rec.priority) as Todo['priority'])
          : undefined,
        note: rec.note ? String(rec.note) : undefined,
      });
    }

    if (todos.length === 0) return fail('No valid todo items were supplied.');

    ctx.session.plan.set(todos);
    const rendered = ctx.session.plan.render();
    ctx.ui.toolDetail(rendered);

    return ok(`Plan updated (${ctx.session.plan.done}/${todos.length} done):\n${rendered}`, {
      display: rendered,
      data: { count: todos.length },
    });
  },
};
