import type { AgentConfig } from '../config.js';
import { OllamaProvider } from '../llm/ollama.js';
import type { LLMProvider, Message } from '../llm/types.js';
import { PermissionGate } from '../safety/permissions.js';
import { ToolRegistry } from '../tools/registry.js';
import type { UI } from '../ui/ui.js';
import { newSession, type SessionState } from '../util/session.js';
import { compactHistory } from './compact.js';
import { buildRepoContext, buildSystemPrompt } from './context.js';
import { runTurn, type TurnResult } from './loop.js';
import { estimateMessages, formatTokens } from './tokens.js';

export type ProviderFactory = (cfg: AgentConfig) => LLMProvider;

export const defaultProviderFactory: ProviderFactory = (cfg) => {
  if (cfg.provider === 'ollama') return OllamaProvider.fromConfig(cfg);
  throw new Error(`provider "${cfg.provider}" needs an explicit factory`);
};

export interface RuntimeOptions {
  ui: UI;
  config: AgentConfig;
  provider?: LLMProvider;
  registry?: ToolRegistry;
  factory?: ProviderFactory;
}

/**
 * Owns everything that persists across turns: the message history, the model
 * handle, the permission gate and the plan. The REPL and the one-shot runner
 * are both thin wrappers around this.
 */
export class AgentRuntime {
  readonly ui: UI;
  config: AgentConfig;
  provider: LLMProvider;
  readonly registry: ToolRegistry;
  readonly permissions: PermissionGate;
  readonly session: SessionState;
  messages: Message[] = [];
  systemPrompt = '';
  repoContext = '';
  private readonly factory: ProviderFactory;

  private constructor(opts: RuntimeOptions) {
    this.ui = opts.ui;
    this.config = opts.config;
    this.factory = opts.factory ?? defaultProviderFactory;
    this.provider = opts.provider ?? this.factory(opts.config);
    this.registry = opts.registry ?? new ToolRegistry();
    this.session = newSession(opts.config);
    this.permissions = new PermissionGate(opts.config.permissionMode, this.session, opts.ui);
  }

  static async create(opts: RuntimeOptions): Promise<AgentRuntime> {
    const rt = new AgentRuntime(opts);
    await rt.refreshContext();
    return rt;
  }

  /** Rebuild the environment block + system prompt (call after cd/model change). */
  async refreshContext(): Promise<void> {
    const ctx = await buildRepoContext(this.config.workspace);
    this.repoContext = ctx.text;
    this.systemPrompt = buildSystemPrompt({
      modelName: this.config.model,
      repoContext: ctx.text,
      customInstructions: this.config.customInstructions,
      toolNames: this.registry.names,
      permissionMode: this.config.permissionMode,
    });
    const head: Message = { role: 'system', content: this.systemPrompt };
    this.messages = [head, ...this.messages.filter((m) => m.role !== 'system')];
    this.session.model = this.config.model;
  }

  /** Swap model at runtime. Call `await refreshContext()` afterwards. */
  setModel(tag: string): void {
    this.config.model = tag;
    this.provider = this.factory(this.config);
  }

  /** Call `await refreshContext()` afterwards so the prompt reflects the new mode. */
  setPermissionMode(mode: AgentConfig['permissionMode']): void {
    this.config.permissionMode = mode;
    this.permissions.setMode(mode);
  }

  clearHistory(): void {
    this.messages = [{ role: 'system', content: this.systemPrompt }];
    this.session.plan.clear();
    this.session.stepsUsed = 0;
  }

  /** Drop the last user turn and everything after it (undo a bad request). */
  undoLast(): boolean {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i];
      if (m && m.role === 'user' && !m.content.startsWith('[agent')) {
        this.messages = this.messages.slice(0, i);
        return true;
      }
    }
    return false;
  }

  compactNow(): { before: number; after: number; dropped: number } {
    const before = estimateMessages(this.messages);
    const res = compactHistory(this.messages, {
      budgetTokens: Math.max(1024, Math.floor(this.config.numCtx * 0.4)),
      keepRecent: 6,
    });
    if (res.compacted) this.messages = res.messages;
    return { before, after: estimateMessages(this.messages), dropped: res.dropped };
  }

  tokenEstimate(): number {
    return estimateMessages(this.messages);
  }

  statsLine(): string {
    const t = this.session.totals;
    return [
      `model ${this.config.model}`,
      `context ~${formatTokens(this.tokenEstimate())}/${this.config.numCtx} tok`,
      `messages ${this.messages.length}`,
      `steps ${this.session.stepsUsed}`,
      `in ${formatTokens(t.promptTokens)} / out ${formatTokens(t.completionTokens)} tok`,
      `llm ${(t.llmMs / 1000).toFixed(1)}s · tools ${(t.toolMs / 1000).toFixed(1)}s`,
    ].join(' · ');
  }

  send(text: string, signal: AbortSignal): Promise<TurnResult> {
    if (this.messages.length === 0 || this.messages[0]?.role !== 'system') {
      this.messages.unshift({ role: 'system', content: this.systemPrompt });
    }
    return runTurn(this.messages, text, {
      provider: this.provider,
      registry: this.registry,
      permissions: this.permissions,
      ui: this.ui,
      config: this.config,
      session: this.session,
      systemPrompt: this.systemPrompt,
    }, signal);
  }
}
