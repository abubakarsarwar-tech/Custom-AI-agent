import type { AgentConfig } from '../config.js';
import type { PermissionGate } from '../safety/permissions.js';
import type { SessionState } from '../util/session.js';
import type { JsonSchema } from '../llm/types.js';
import type { UI } from '../ui/ui.js';
import type { SkillLibrary } from '../skills/library.js';
import type { LessonStore } from '../memory/lessons.js';
import type { CheckpointStore } from '../agent/checkpoint.js';
import type { SubagentRunner } from '../agent/subagent.js';

export interface ToolResult {
  /** What goes back into the model's context. Keep it tight — tokens are scarce locally. */
  content: string;
  isError?: boolean;
  /** Structured extras for the UI (diffs, file lists) that the model never sees. */
  display?: string;
  data?: Record<string, unknown>;
}

export interface ToolContext {
  workspace: string;
  config: AgentConfig;
  permissions: PermissionGate;
  session: SessionState;
  ui: UI;
  signal: AbortSignal;
  /** null when the skills system is switched off. */
  skills: SkillLibrary | null;
  /** null when memory is switched off. */
  memory: LessonStore | null;
  /** null when checkpointing is switched off. Mutating tools capture before writing. */
  checkpoint: CheckpointStore | null;
  /** null when sub-agents are switched off, or inside a sub-agent (no nesting). */
  subagent: SubagentRunner | null;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  /** low = never prompts, medium = prompts in ask mode, high = always careful */
  readonly risk: 'low' | 'medium' | 'high';
  run(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  /** Short human-readable line for the approval prompt / transcript. */
  summarize(rawArgs: Record<string, unknown>): string;
}

/* ---------- argument coercion helpers (local models send sloppy args) ---------- */

export function str(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key];
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

export function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v == null || v === '') return undefined;
  return typeof v === 'string' ? v : String(v);
}

export function int(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

export function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'yes', '1', 'y'].includes(s)) return true;
    if (['false', 'no', '0', 'n'].includes(s)) return false;
  }
  return fallback;
}

export function fail(message: string, data?: Record<string, unknown>): ToolResult {
  return { content: message, isError: true, ...(data ? { data } : {}) };
}

export function ok(content: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { content, ...extra };
}
