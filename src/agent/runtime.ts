import type { AgentConfig } from '../config.js';
import { OllamaProvider } from '../llm/ollama.js';
import type { LLMProvider, Message } from '../llm/types.js';
import { PermissionGate } from '../safety/permissions.js';
import { ToolRegistry } from '../tools/registry.js';
import { useSkillTool } from '../tools/use-skill.js';
import { ALL_TOOLS } from '../tools/registry.js';
import { SkillLibrary } from '../skills/library.js';
import { LessonStore } from '../memory/lessons.js';
import { CheckpointStore, humanBytes, type Checkpoint, type RestoreResult } from './checkpoint.js';
import { rememberTool } from '../tools/remember.js';
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
  /** Always present; `enabled=false` when skills are switched off. */
  skills: SkillLibrary;
  /** Cross-session memory. null when disabled. */
  memory: LessonStore | null;
  /** Per-turn file snapshots. null when disabled. */
  checkpoints: CheckpointStore | null;
  readonly permissions: PermissionGate;
  readonly session: SessionState;
  messages: Message[] = [];
  systemPrompt = '';
  repoContext = '';
  /** Lesson ids injected into the most recent turn, so feedback can vote on them. */
  lastInjectedLessons: string[] = [];
  private readonly factory: ProviderFactory;

  private constructor(
    opts: RuntimeOptions,
    skills: SkillLibrary,
    memory: LessonStore | null,
    checkpoints: CheckpointStore | null,
  ) {
    this.ui = opts.ui;
    this.config = opts.config;
    this.factory = opts.factory ?? defaultProviderFactory;
    this.provider = opts.provider ?? this.factory(opts.config);
    this.skills = skills;
    this.memory = memory;
    this.checkpoints = checkpoints;
    const tools = memory ? [...ALL_TOOLS, rememberTool] : ALL_TOOLS;
    this.registry = opts.registry ?? new ToolRegistry(tools);
    // use_skill exists only when there are skills to use — that keeps its schema
    // out of the prompt (~90 tokens) when the system is switched off. Enforced
    // here rather than at construction so a caller-supplied registry cannot
    // silently lose skill support.
    if (skills.enabled && skills.count > 0 && !this.registry.has(useSkillTool.name)) {
      this.registry.register(useSkillTool);
    }
    if (memory && !this.registry.has(rememberTool.name)) {
      this.registry.register(rememberTool);
    }
    this.session = newSession(opts.config);
    this.permissions = new PermissionGate(opts.config.permissionMode, this.session, opts.ui);
  }

  static async create(opts: RuntimeOptions): Promise<AgentRuntime> {
    const skills = await SkillLibrary.create(opts.config.workspace, {
      enabled: opts.config.skillsEnabled,
      extraDirs: opts.config.skillsDirs,
      maxBodyChars: opts.config.skillsMaxBodyChars,
    });
    const memory = opts.config.memoryEnabled
      ? await LessonStore.open(opts.config.stateDir)
      : null;
    const checkpoints = opts.config.checkpointsEnabled
      ? await CheckpointStore.open(opts.config.stateDir, { keep: opts.config.checkpointsKeep })
      : null;
    const rt = new AgentRuntime(opts, skills, memory, checkpoints);
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
      skillsIndex: this.skills.enabled ? this.skills.renderIndex() : '',
      skillsAutoRoute: this.config.skillsAutoRoute,
      memoryEnabled: Boolean(this.memory),
      memoryCount: this.memory?.count ?? 0,
      checkpointsEnabled: Boolean(this.checkpoints),
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
    // History is gone, so any skill body in it is gone too.
    this.skills.forgetAll();
  }

  /** Drop the last user turn and everything after it (undo a bad request). */
  undoLast(): boolean {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i];
      // Skip harness-injected notes: plan reminders, compaction logs, skill loads.
      if (m && m.role === 'user' && !m.content.startsWith('[')) {
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
      this.skills.loadedNames().length > 0 ? `skills ${this.skills.loadedNames().join('+')}` : '',
      this.memory && this.memory.count > 0 ? `memory ${this.memory.count}` : '',
      `in ${formatTokens(t.promptTokens)} / out ${formatTokens(t.completionTokens)} tok`,
      `llm ${(t.llmMs / 1000).toFixed(1)}s · tools ${(t.toolMs / 1000).toFixed(1)}s`,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /**
   * Deterministic skill routing.
   *
   * Asking a 7B model "which of these ten skills applies?" costs a full
   * round-trip (5-30s on a laptop) and it often answers badly. When the
   * keyword score is confident we load the skill OURSELVES and inject it, so
   * the model's very first turn already has the right expertise. Ambiguous
   * requests are left alone and the model can still call use_skill itself.
   */
  autoLoadSkill(userText: string): { note: string; skill: string } | null {
    if (!this.config.skillsAutoRoute || !this.skills.enabled) return null;
    const decision = this.skills.autoRoute(userText);
    const top = decision.scored[0];
    if (!decision.pick || !top) return null;
    if (this.skills.isLoaded(decision.pick.name)) return null;

    const note = this.buildSkillNote(decision.pick.name, top.matched);
    return note ? { note, skill: decision.pick.name } : null;
  }

  /** Load a skill body into the conversation and label where it came from. */
  private buildSkillNote(name: string, matched: string[], forced = false): string | null {
    if (this.skills.isLoaded(name)) return null;
    const loaded = this.skills.load(name);
    if (!loaded) return null;
    const tag = forced ? 'skill loaded' : 'skill auto-loaded';
    const why = !forced && matched.length > 0 ? ` — matched ${matched.slice(0, 3).join(', ')}` : '';
    return (
      `[${tag}: ${name}${why}]\n` +
      'Follow these instructions while handling the request below. ' +
      'If they turn out not to apply, ignore them and say so in one line.\n\n' +
      loaded.text
    );
  }

  /** Force a skill into context (--skill flag, or /skill in the REPL). */
  preloadSkill(name: string): boolean {
    if (!this.skills.enabled || !this.skills.get(name)) return false;
    if (this.skills.isLoaded(name)) return true;
    const note = this.buildSkillNote(name, [], true);
    if (!note) return false;
    this.messages.push({ role: 'user', content: note });
    return true;
  }

  /** `signal` is optional: a programmatic caller should not need an AbortController. */
  async send(text: string, signal: AbortSignal = new AbortController().signal): Promise<TurnResult> {
    if (this.messages.length === 0 || this.messages[0]?.role !== 'system') {
      this.messages.unshift({ role: 'system', content: this.systemPrompt });
    }

    const auto = this.autoLoadSkill(text);
    if (auto) {
      this.messages.push({ role: 'user', content: auto.note });
      this.ui.note(`skill auto-loaded: ${auto.skill}`);
      this.ui.emitSkill?.(auto.skill);
    }

    // Recall anything relevant learned in previous sessions. This is what makes
    // the agent better on day two than day one, without touching model weights.
    this.lastInjectedLessons = [];
    if (this.memory && this.memory.count > 0) {
      const recalled = this.memory.renderBlockWithIds(text, this.config.memoryMaxInject);
      if (recalled.text) {
        this.messages.push({ role: 'user', content: recalled.text });
        this.lastInjectedLessons = recalled.ids;
        this.ui.note(`recalled ${recalled.ids.length} remembered fact${recalled.ids.length === 1 ? '' : 's'}`);
      }
    }

    // Snapshot everything this turn is about to change. Opened before the loop
    // and closed in `finally`, so an interrupted or failed turn is still
    // reversible — that is exactly when you most want to roll back.
    this.checkpoints?.begin(text);
    try {
      return await runTurn(
        this.messages,
        text,
        {
          provider: this.provider,
          registry: this.registry,
          permissions: this.permissions,
          ui: this.ui,
          config: this.config,
          session: this.session,
          systemPrompt: this.systemPrompt,
          skills: this.skills,
          memory: this.memory,
          checkpoint: this.checkpoints,
        },
        signal,
      );
    } finally {
      const saved = await this.checkpoints?.finish();
      if (saved) {
        const nouns = saved.files.length === 1 ? 'file' : 'files';
        this.ui.note(`checkpoint ${saved.id}: ${saved.files.length} ${nouns} can be rolled back`);
        this.ui.emitCheckpoint(saved);
      }
    }
  }

  /* ---------------- checkpoints ---------------- */

  /** Newest first. */
  checkpointList(): Checkpoint[] {
    return this.checkpoints?.list() ?? [];
  }

  /**
   * Roll the workspace back to how it looked before that turn. The state being
   * left is checkpointed too, so a restore can itself be undone.
   */
  async restoreCheckpoint(id: string): Promise<RestoreResult | null> {
    if (!this.checkpoints) return null;
    const result = await this.checkpoints.restore(id, this.config.workspace);
    if (result) {
      const parts = [
        result.reverted.length ? `${result.reverted.length} reverted` : '',
        result.deleted.length ? `${result.deleted.length} deleted` : '',
      ].filter(Boolean);
      this.ui.success(`restored ${id}${parts.length ? ` (${parts.join(', ')})` : ''}`);
    }
    return result;
  }

  async checkpointSummary(): Promise<string> {
    if (!this.checkpoints) return 'checkpoints off';
    const bytes = await this.checkpoints.sizeBytes();
    return `${this.checkpoints.count} checkpoint(s), ${humanBytes(bytes)}`;
  }
}
