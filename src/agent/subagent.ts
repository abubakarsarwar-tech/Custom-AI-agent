import { UI } from '../ui/ui.js';
import type { UIEvent } from '../ui/ui.js';
import type { AgentConfig, PermissionMode } from '../config.js';
import type { LLMProvider, Message } from '../llm/types.js';
import type { PermissionGate } from '../safety/permissions.js';
import { ToolRegistry } from '../tools/registry.js';
import type { SkillLibrary } from '../skills/library.js';
import type { CheckpointStore } from './checkpoint.js';
import type { SessionState } from '../util/session.js';
import { newSession } from '../util/session.js';
import { PermissionGate as Gate } from '../safety/permissions.js';
import { estimateTokens } from './tokens.js';
import { runTurn, type TurnResult } from './loop.js';
import { taskTool } from '../tools/task.js';
import { rememberTool } from '../tools/remember.js';
import { useSkillTool } from '../tools/use-skill.js';

export type SubagentKind = 'explore' | 'work';

export interface SubagentRequest {
  prompt: string;
  kind: SubagentKind;
  signal: AbortSignal;
}

export interface SubagentReport {
  ok: boolean;
  /** What the parent puts in its context. Already capped. */
  report: string;
  kind: SubagentKind;
  steps: number;
  toolCalls: number;
  truncated: boolean;
  hitMaxSteps: boolean;
  aborted: boolean;
  error?: string;
  tokens: { prompt: number; completion: number };
  ms: number;
}

export type SubagentRunner = (req: SubagentRequest) => Promise<SubagentReport>;

export interface SubagentDeps {
  provider: LLMProvider;
  config: AgentConfig;
  /** The parent's registry, so the child gets the same tools minus `task`. */
  registry: ToolRegistry;
  /** The parent's UI: the child relays events to it and borrows its ask hook. */
  ui: UI;
  skills: SkillLibrary;
  /** The parent's environment block — same workspace, so reuse it for free. */
  repoContext: string;
  session: SessionState;
  /** Shared with the parent so one approval story covers both. */
  permissions: PermissionGate;
  /** Shared with the parent: a child's writes roll back with the parent's turn. */
  checkpoints: CheckpointStore | null;
}

/** What the child is told. Deliberately not the parent's prompt: nobody human is
 *  reading this output, so the contract is "dense report, no questions". */
export function buildSubagentPrompt(input: {
  kind: SubagentKind;
  repoContext: string;
  maxSteps: number;
  permissionMode: PermissionMode;
  skillsIndex: string;
  reportChars: number;
}): string {
  const readonly = input.permissionMode === 'readonly';
  const lines: string[] = [
    'You are a SUB-AGENT inside LCA, a local coding agent. You were spawned by a parent agent to do ONE job, then report back.',
    'There is no human reading your output directly: the parent agent reads it and decides what to do next.',
    '',
    '<environment>',
    input.repoContext,
    '</environment>',
    '',
    '<your_contract>',
    `- Budget: at most ${input.maxSteps} tool rounds. Spend them on searching and reading, not on re-reading the same file.`,
    readonly
      ? '- You are READ-ONLY. You cannot write, edit or run shell commands; do not try. Report what should change and where, precisely enough for the parent to do it.'
      : '- You may change files. Make small, correct edits and verify them.',
    `- Finish with a dense factual report of at most ~${input.reportChars} characters. Longer reports are truncated, so put the important part first.`,
    '- Cite exact file paths and line numbers. Quote only the few lines that matter.',
    '- Never ask a question — nobody can answer it. If you are blocked, say what is missing and what you already tried.',
    '- No preamble, no restating the task, no "I will now…". Bullet points over prose.',
    '- If you found nothing, say so plainly and list what you searched. An honest empty result beats an invented one.',
    '</your_contract>',
  ];

  if (input.skillsIndex) {
    lines.push(
      '',
      '<skills>',
      'Specialised instructions are available. If one clearly matches your job, call use_skill(name) ONCE first.',
      input.skillsIndex,
      '</skills>',
    );
  }

  return lines.join('\n');
}

/** Print a child's activity in the terminal without giving it the full stage. */
function renderChildEvent(ui: UI, event: UIEvent): void {
  switch (event.type) {
    case 'tool_start':
      ui.raw(`  ${dim(`│ ⚒ ${event.name} ${event.summary.slice(0, 90)}`)}\n`);
      break;
    case 'tool_end':
      ui.raw(
        `  ${dim(`│ ${event.ok ? '✔' : '✖'} ${event.name} · ${event.ms}ms`)}\n`,
      );
      break;
    case 'warn':
      ui.raw(`  ${dim(`│ ⚠ ${event.text}`)}\n`);
      break;
    case 'error':
      ui.raw(`  ${dim(`│ ✖ ${event.text}`)}\n`);
      break;
    default:
      // The child's streamed prose is an internal report; the parent summarises it.
      break;
  }
}

function dim(s: string): string {
  return `\u001b[2m${s}\u001b[22m`;
}

/**
 * Run one sub-agent: a fresh context, a bounded loop, and a report that is the
 * ONLY thing that comes back into the parent's window.
 *
 * Why this exists on a laptop: an 8k context is the real budget. "Find where
 * auth is handled" can burn 6k tokens of reads that the parent then has to carry
 * for the rest of the conversation. A sub-agent burns its own window and returns
 * ~300 tokens of findings. That is context isolation, and it beats compaction
 * because nothing was ever loaded in the first place.
 *
 * Safety rails, all structural rather than prompt-based:
 *  - no nesting: the child's registry has no `task` tool, so it cannot spawn one
 *  - `explore` is readonly; `work` inherits the parent's permission mode
 *  - the parent's abort signal is passed straight through, so Stop stops both
 *  - the parent's CheckpointStore is shared, so a child's writes roll back with
 *    the parent's turn — one undo boundary, not two
 *  - approvals are shared (same `alwaysAllowed` set), so the user is not asked
 *    twice for the same thing, and a child's prompt is labelled `[sub-agent]`
 */
export async function runSubagent(
  deps: SubagentDeps,
  req: SubagentRequest,
): Promise<SubagentReport> {
  const t0 = Date.now();
  const maxSteps = Math.max(1, Math.min(deps.config.subagentMaxSteps, deps.config.maxSteps));
  const mode: PermissionMode = req.kind === 'explore' ? 'readonly' : deps.config.permissionMode;

  const childConfig: AgentConfig = {
    ...deps.config,
    maxSteps,
    permissionMode: mode,
  };

  // Fresh counters and plan; shared approval state. The child's spend is added
  // back into the parent's totals afterwards, because those tokens were real.
  const childSession = newSession(childConfig);
  childSession.alwaysAllowed = deps.session.alwaysAllowed;
  childSession.approvedCommands = deps.session.approvedCommands;

  // The child gets a terminal-less UI that still emits every event: quiet output,
  // full stream. The parent decides what to show where.
  const childUI = new UI({ quiet: true, verbose: false, interactive: false, write: () => {} });
  childUI.listener = (event: UIEvent) => {
    deps.ui.relay(event);
    renderChildEvent(deps.ui, event);
  };
  // Borrow the parent's approval hook so prompts land in the same place
  // (terminal or browser dialog), clearly labelled as coming from a sub-agent.
  childUI.ask = (askReq) => {
    if (!deps.ui.ask) return Promise.resolve(deps.ui.nonInteractiveAnswer);
    return deps.ui.ask({ ...askReq, summary: `[sub-agent] ${askReq.summary}` });
  };
  childUI.nonInteractiveAnswer = deps.ui.nonInteractiveAnswer;

  // Same tools as the parent, minus `task` (no nesting) and minus `remember`
  // (memory belongs to the conversation, which the child does not have).
  const childRegistry = new ToolRegistry(
    deps.registry
      .list()
      .filter((t) => t.name !== taskTool.name && t.name !== rememberTool.name),
  );

  // Its own loaded-set: a skill the child loads must not make the parent think
  // it already has those instructions in context.
  const childSkills = deps.skills.spawn();
  if (childSkills.enabled && childSkills.count > 0 && !childRegistry.has(useSkillTool.name)) {
    childRegistry.register(useSkillTool);
  }

  const systemPrompt = buildSubagentPrompt({
    kind: req.kind,
    repoContext: deps.repoContext,
    maxSteps,
    permissionMode: mode,
    skillsIndex: childSkills.enabled ? childSkills.renderIndex() : '',
    reportChars: deps.config.subagentReportChars,
  });

  // A clear route loads the skill before the first model call, same as the parent.
  const messages: Message[] = [{ role: 'system', content: systemPrompt }];
  const route = childSkills.autoRoute(req.prompt);
  const picked = route.pick?.name;
  if (picked && route.confidence === 'strong' && !childSkills.isLoaded(picked)) {
    const loaded = childSkills.load(picked);
    if (loaded) {
      messages.push({
        role: 'user',
        content: `[skill auto-loaded: ${picked}]\nFollow these instructions for the job below.\n\n${loaded.text}`,
      });
      childUI.emitSkill(picked);
    }
  }

  const permissions = new Gate(mode, childSession, childUI);

  deps.ui.emitSubagentStart({ prompt: req.prompt, kind: req.kind, maxSteps });

  let result: TurnResult;
  try {
    result = await runTurn(
      messages,
      req.prompt,
      {
        provider: deps.provider,
        registry: childRegistry,
        permissions,
        ui: childUI,
        config: childConfig,
        session: childSession,
        systemPrompt,
        skills: childSkills,
        memory: null,
        checkpoint: deps.checkpoints,
        subagent: null, // belt and braces: the tool is gone AND the runner is null
      },
      req.signal,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.ui.emitSubagentEnd({ ok: false, kind: req.kind, error: msg });
    return {
      ok: false,
      report: `The sub-agent crashed: ${msg}`,
      kind: req.kind,
      steps: childSession.stepsUsed,
      toolCalls: 0,
      truncated: false,
      hitMaxSteps: false,
      aborted: req.signal.aborted,
      error: msg,
      tokens: {
        prompt: childSession.totals.promptTokens,
        completion: childSession.totals.completionTokens,
      },
      ms: Date.now() - t0,
    };
  }

  // The child's spend is real spend. Fold it into the parent's totals so /stats
  // and the stats line never under-report what a turn cost.
  deps.session.totals.promptTokens += childSession.totals.promptTokens;
  deps.session.totals.completionTokens += childSession.totals.completionTokens;
  deps.session.totals.llmMs += childSession.totals.llmMs;
  deps.session.totals.toolMs += childSession.totals.toolMs;

  const cap = deps.config.subagentReportChars;
  const raw = (result.answer ?? '').trim();
  const truncated = raw.length > cap;
  const body = truncated
    ? `${raw.slice(0, cap)}\n…[report truncated at ${cap} chars — ask for a narrower question if you need the rest]`
    : raw;

  const caveats: string[] = [];
  if (result.aborted) caveats.push('ABORTED part-way, so this report is incomplete');
  if (result.hitMaxSteps) caveats.push(`hit the ${maxSteps}-step limit, so it may not have finished`);
  if (result.error) caveats.push(`error: ${result.error}`);

  const report = caveats.length > 0 ? `${body}\n\n[!] ${caveats.join('; ')}.` : body;
  const ok = !result.aborted && !result.error;

  deps.ui.emitSubagentEnd({
    ok,
    kind: req.kind,
    steps: result.steps,
    toolCalls: result.toolCalls,
    tokens: estimateTokens(report),
    ...(result.error ? { error: result.error } : {}),
  });

  return {
    ok,
    report: report || '(the sub-agent returned nothing)',
    kind: req.kind,
    steps: result.steps,
    toolCalls: result.toolCalls,
    truncated,
    hitMaxSteps: result.hitMaxSteps,
    aborted: result.aborted,
    ...(result.error ? { error: result.error } : {}),
    tokens: {
      prompt: childSession.totals.promptTokens,
      completion: childSession.totals.completionTokens,
    },
    ms: Date.now() - t0,
  };
}
