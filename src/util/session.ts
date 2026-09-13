import type { AgentConfig } from '../config.js';
import { PlanStore } from '../agent/plan.js';

export interface SessionState {
  /** Tool names the user approved with "always" for this session. */
  alwaysAllowed: Set<string>;
  /** Exact bash commands already approved this session. */
  approvedCommands: Set<string>;
  stepsUsed: number;
  startedAt: number;
  model: string;
  plan: PlanStore;
  /** Running totals so we can tell the user what a session cost in time/tokens. */
  totals: { promptTokens: number; completionTokens: number; llmMs: number; toolMs: number };
  lastUsage: { promptTokens: number; completionTokens: number; durationMs: number } | null;
}

export function newSession(cfg: AgentConfig): SessionState {
  return {
    alwaysAllowed: new Set(cfg.autoApprove),
    approvedCommands: new Set(),
    stepsUsed: 0,
    startedAt: Date.now(),
    model: cfg.model,
    plan: new PlanStore(),
    totals: { promptTokens: 0, completionTokens: 0, llmMs: 0, toolMs: 0 },
    lastUsage: null,
  };
}
