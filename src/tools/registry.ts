import type { ToolSpec } from '../llm/types.js';
import { bashTool } from './bash.js';
import { editFileTool } from './edit-file.js';
import { listDirTool } from './list-dir.js';
import { readFileTool } from './read-file.js';
import { searchTool } from './search.js';
import { todoTool } from './todo.js';
import { writeFileTool } from './write-file.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

export const ALL_TOOLS: Tool[] = [
  readFileTool,
  editFileTool,
  writeFileTool,
  listDirTool,
  searchTool,
  bashTool,
  todoTool,
];

export class ToolRegistry {
  private readonly byName = new Map<string, Tool>();

  constructor(tools: Tool[] = ALL_TOOLS) {
    for (const tool of tools) this.byName.set(tool.name, tool);
  }

  /** Add a tool after construction (used for the optional use_skill tool). */
  register(tool: Tool): void {
    this.byName.set(tool.name, tool);
  }

  get names(): string[] {
    return [...this.byName.keys()];
  }

  list(): Tool[] {
    return [...this.byName.values()];
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  /** The JSON schema block sent to the model. */
  specs(): ToolSpec[] {
    return this.list().map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * Single entry point for executing a call. Every failure is returned as a
   * tool result rather than thrown, so one bad call can never kill the loop —
   * the model just reads the error and tries again.
   */
  async invoke(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.byName.get(name);
    if (!tool) {
      return {
        content:
          `Unknown tool "${name}". Available tools: ${this.names.join(', ')}. ` +
          'Use exactly one of those names.',
        isError: true,
      };
    }
    let args: Record<string, unknown> = {};
    if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      args = rawArgs as Record<string, unknown>;
    }
    try {
      return await tool.run(args, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `${name} crashed: ${msg}`, isError: true };
    }
  }
}
