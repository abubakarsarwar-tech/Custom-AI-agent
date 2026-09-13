import type { AgentConfig } from '../config.js';
import type { LLMProvider, Message, ToolCall } from '../llm/types.js';
import type { PermissionGate } from '../safety/permissions.js';
import type { ToolRegistry } from '../tools/registry.js';
import { normalizeArgs } from '../tools/arg-aliases.js';
import type { UI } from '../ui/ui.js';
import type { SkillLibrary } from '../skills/library.js';
import type { LessonStore } from '../memory/lessons.js';
import type { CheckpointStore } from './checkpoint.js';
import type { SubagentRunner } from './subagent.js';
import type { SessionState } from '../util/session.js';
import { compactHistory } from './compact.js';
import { StreamEcho } from './stream-filter.js';
import { estimateMessages, formatTokens } from './tokens.js';

export interface AgentDeps {
  provider: LLMProvider;
  registry: ToolRegistry;
  permissions: PermissionGate;
  ui: UI;
  config: AgentConfig;
  session: SessionState;
  systemPrompt: string;
  skills: SkillLibrary | null;
  memory: LessonStore | null;
  checkpoint: CheckpointStore | null;
  subagent: SubagentRunner | null;
}

export interface TurnResult {
  answer: string;
  steps: number;
  toolCalls: number;
  aborted: boolean;
  error?: string;
  hitMaxSteps: boolean;
}

const MAX_IDENTICAL_CALLS = 3;
const MAX_CONSECUTIVE_ERRORS = 4;
/** Reserve room for the reply itself; the window is shared with output tokens. */
const CONTEXT_SAFETY_MARGIN = 900;

function callKey(tc: ToolCall): string {
  return `${tc.name}:${JSON.stringify(tc.arguments)}`;
}

/**
 * The agent loop — the heart of the whole project. Everything else exists to
 * support these few dozen lines:
 *
 *   send conversation + tool schemas to the model
 *   if the model asked for tools -> run them, append results, loop again
 *   otherwise -> it produced an answer, so stop
 *
 * A chatbot is one round-trip. An agent is this loop.
 */
export async function runTurn(
  messages: Message[],
  userText: string,
  deps: AgentDeps,
  signal: AbortSignal,
): Promise<TurnResult> {
  const { provider, registry, permissions, ui, config, session, skills, memory, checkpoint, subagent } =
    deps;

  messages.push({ role: 'user', content: userText });

  let steps = 0;
  let totalCalls = 0;
  let consecutiveErrors = 0;
  const repeatCounter = new Map<string, number>();
  let finalAnswer = '';
  let aborted = false;
  let errorText: string | undefined;
  let hitMaxSteps = false;

  const toolSpecs = registry.specs();

  while (steps < config.maxSteps) {
    if (signal.aborted) {
      aborted = true;
      break;
    }
    steps += 1;
    session.stepsUsed += 1;

    /* ---- 1. keep the conversation inside the model's real window ---- */
    const budget = Math.max(2048, config.numCtx - CONTEXT_SAFETY_MARGIN);
    const compacted = compactHistory(messages, { budgetTokens: budget, keepRecent: 8 });
    if (compacted.compacted) {
      messages.length = 0;
      messages.push(...compacted.messages);
      ui.note(
        `context compacted: ${formatTokens(compacted.beforeTokens)} → ${formatTokens(
          compacted.afterTokens,
        )} tokens (${compacted.dropped} messages summarised)`,
      );
    }

    /* ---- 2. re-anchor the model on its plan during long runs ---- */
    if (steps > 2 && !session.plan.isEmpty) {
      messages.push({
        role: 'user',
        content:
          `[agent reminder] Current plan:\n${session.plan.render()}\n` +
          'Keep going. Update it with todo_write as soon as an item changes status.',
      });
    }

    ui.startSpinner(
      steps === 1
        ? `thinking (${config.model})`
        : `thinking · step ${steps}/${config.maxSteps} · ${formatTokens(estimateMessages(messages))} tok`,
    );

    /* ---- 3. ask the model, streaming tokens to the terminal ---- */
    let text = '';
    let toolCalls: ToolCall[] = [];
    let firstDelta = true;
    let streamError: string | undefined;
    const echo = new StreamEcho();

    const emit = (s: string): void => {
      if (!s) return;
      if (firstDelta) {
        ui.beginAssistant();
        firstDelta = false;
      }
      ui.chunk(s);
    };

    for await (const event of provider.stream(messages, toolSpecs, {
      signal,
      temperature: config.temperature,
      numCtx: config.numCtx,
    })) {
      switch (event.type) {
        case 'delta':
          // Hide prose JSON that is really a tool call in disguise.
          emit(echo.push(event.text));
          break;
        case 'tool_calls':
          toolCalls = event.toolCalls;
          break;
        case 'done':
          text = event.text;
          if (event.toolCalls.length > 0) toolCalls = event.toolCalls;
          session.lastUsage = event.usage;
          session.totals.promptTokens += event.usage.promptTokens;
          session.totals.completionTokens += event.usage.completionTokens;
          session.totals.llmMs += event.usage.durationMs;
          break;
        case 'error':
          streamError = event.error;
          break;
        default:
          break;
      }
    }
    // Release held-back text, or give it back if it was not a tool call after all.
    if (toolCalls.length > 0) emit(echo.finish());
    else emit(echo.revealAll());
    ui.stopSpinner();
    ui.endAssistant();

    if (streamError) {
      errorText = streamError;
      ui.error(streamError);
      break;
    }

    /* ---- 4. no tool call == the model is answering, so the turn ends ---- */
    if (toolCalls.length === 0) {
      finalAnswer = text.trim();
      messages.push({ role: 'assistant', content: text });
      break;
    }

    // Record the assistant turn exactly as produced, so the provider can replay
    // tool_calls back to Ollama next round (required by the chat protocol).
    messages.push({ role: 'assistant', content: text, tool_calls: toolCalls });

    /* ---- 5. execute every requested tool, append observations ---- */
    for (const call of toolCalls) {
      if (signal.aborted) {
        aborted = true;
        break;
      }
      totalCalls += 1;

      const tool = registry.get(call.name);
      const args = normalizeArgs(call.name, call.arguments ?? {});
      const summary = tool ? tool.summarize(args) : JSON.stringify(args).slice(0, 120);

      // Loop breaker: models get stuck re-issuing one failing call forever.
      const key = callKey({ ...call, arguments: args });
      const seen = (repeatCounter.get(key) ?? 0) + 1;
      repeatCounter.set(key, seen);
      if (seen > MAX_IDENTICAL_CALLS) {
        ui.warn(`loop breaker: ${call.name} repeated ${seen}x`);
        messages.push({
          role: 'tool',
          tool_name: call.name,
          content:
            `You have issued this identical call ${seen} times. Stop repeating it. ` +
            'The approach is wrong or you are missing information: re-read the file, ' +
            'change the arguments, or tell the user what is blocking you.',
        });
        continue;
      }

      ui.toolStart(call.name, summary);
      if (call.repaired) ui.note('recovered a tool call from plain text (native function calling failed)');

      const t0 = Date.now();
      const result = await registry.invoke(call.name, args, {
        workspace: config.workspace,
        config,
        permissions,
        session,
        ui,
        signal,
        skills,
        memory,
        checkpoint,
        subagent,
      });
      const ms = Date.now() - t0;
      session.totals.toolMs += ms;

      // On failure show WHY, otherwise the transcript just says ✖ and both you
      // and the model are guessing.
      ui.toolEnd(call.name, !result.isError, ms, result.isError ? result.content : result.display);

      if (result.isError) {
        consecutiveErrors += 1;
      } else {
        consecutiveErrors = 0;
      }

      messages.push({
        role: 'tool',
        tool_name: call.name,
        content: result.content,
      });

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        ui.warn(`${consecutiveErrors} tool errors in a row — stopping this turn`);
        messages.push({
          role: 'user',
          content:
            `[agent] ${consecutiveErrors} consecutive tool calls failed. Stop and report to the user ` +
            'what you were trying to do, what the errors were, and what you need from them.',
        });
        finalAnswer = '';
        // One more model round so it can produce the explanation, then exit.
        steps = config.maxSteps - 1;
        consecutiveErrors = 0;
      }
    }

    if (aborted) break;
  }

  if (steps >= config.maxSteps && !finalAnswer && !errorText && !aborted) {
    hitMaxSteps = true;
    ui.warn(`hit the ${config.maxSteps}-step limit without finishing`);
    finalAnswer =
      finalAnswer ||
      `Stopped after ${steps} steps (the maxSteps limit). The work may be incomplete — ` +
      'run /plan to see the state, or raise LCA_MAX_STEPS.';
  }
  if (aborted && !finalAnswer) finalAnswer = '(interrupted)';

  return {
    answer: finalAnswer,
    steps,
    toolCalls: totalCalls,
    aborted,
    ...(errorText ? { error: errorText } : {}),
    hitMaxSteps,
  };
}
