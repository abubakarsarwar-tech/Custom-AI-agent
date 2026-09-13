import type { AgentConfig } from '../config.js';
import {
  coerceNativeToolCalls,
  lenientJsonParse,
  repairToolCalls,
} from './repair.js';
import {
  nextCallId,
  type GenerateOptions,
  type LLMProvider,
  type Message,
  type StreamEvent,
  type ToolCall,
  type ToolSpec,
} from './types.js';

interface OllamaChatChunk {
  model?: string;
  created_at?: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: unknown;
  };
  done?: boolean;
  done_reason?: string;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

function toOllamaMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_name: m.tool_name ?? '' };
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content ?? '',
        tool_calls: m.tool_calls.map((tc) => ({
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  numCtx: number;
  temperature: number;
  keepAlive: string;
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  private readonly opts: OllamaOptions;

  constructor(opts: OllamaOptions) {
    this.opts = opts;
  }

  static fromConfig(cfg: AgentConfig): OllamaProvider {
    return new OllamaProvider({
      baseUrl: cfg.ollamaUrl,
      model: cfg.model,
      numCtx: cfg.numCtx,
      temperature: cfg.temperature,
      keepAlive: cfg.keepAlive,
    });
  }

  async listModels(): Promise<Array<{ name: string; size: number }>> {
    const res = await fetch(`${this.opts.baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
    const json = (await res.json()) as { models?: Array<{ name: string; size?: number }> };
    return (json.models ?? []).map((m) => ({ name: m.name, size: m.size ?? 0 }));
  }

  async *stream(
    messages: Message[],
    tools: ToolSpec[],
    opts: GenerateOptions = {},
  ): AsyncGenerator<StreamEvent> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: toOllamaMessages(messages),
      stream: true,
      keep_alive: this.opts.keepAlive,
      options: {
        temperature: opts.temperature ?? this.opts.temperature,
        num_ctx: opts.numCtx ?? this.opts.numCtx,
        // Keep the model from wandering off during long agent runs.
        num_predict: -1,
        repeat_penalty: 1.05,
      },
    };
    if (tools.length > 0) body.tools = tools;

    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        type: 'error',
        error:
          opts.signal?.aborted
            ? 'Aborted.'
            : `Could not reach Ollama at ${this.opts.baseUrl}. Is it running? (ollama serve)\n${msg}`,
      };
      return;
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      let detail = text;
      const parsed = lenientJsonParse(text);
      if (parsed?.error) detail = String(parsed.error);
      if (/model .* not found/i.test(detail)) {
        detail += `\n\nFix: run  ollama pull ${this.opts.model}`;
      }
      yield { type: 'error', error: `Ollama error ${res.status}: ${detail}` };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    const toolCalls: ToolCall[] = [];
    const allowed = new Set(tools.map((t) => t.function.name));
    let promptTokens = 0;
    let completionTokens = 0;

    // handleLine is a sync callback, so it queues events into `outbox`;
    // the read loop below drains that box after every socket read, which is
    // what gives us real token-by-token streaming instead of a buffered blob.
    const outbox: StreamEvent[] = [];

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let chunk: OllamaChatChunk;
      try {
        chunk = JSON.parse(trimmed) as OllamaChatChunk;
      } catch {
        return; // partial line, ignore
      }
      if (chunk.error) {
        fullText += `\n[ollama error] ${chunk.error}`;
        return;
      }
      const piece = chunk.message?.content ?? '';
      if (piece) {
        fullText += piece;
        outbox.push({ type: 'delta', text: piece });
      }
      if (chunk.message?.tool_calls) {
        for (const call of coerceNativeToolCalls(chunk.message.tool_calls)) {
          if (!allowed.has(call.name)) continue;
          toolCalls.push({
            id: nextCallId(),
            name: call.name,
            arguments: call.args,
            raw: JSON.stringify(call),
          });
        }
      }
      if (chunk.prompt_eval_count) promptTokens = chunk.prompt_eval_count;
      if (chunk.eval_count) completionTokens = chunk.eval_count;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line);
        nl = buffer.indexOf('\n');
      }
      while (outbox.length > 0) yield outbox.shift() as StreamEvent;
    }
    if (buffer.trim()) handleLine(buffer);
    while (outbox.length > 0) yield outbox.shift() as StreamEvent;

    // Fallback: model printed JSON instead of using native tool calling.
    if (toolCalls.length === 0 && fullText) {
      const repaired = repairToolCalls(fullText, allowed);
      if (repaired.toolCalls.length > 0) {
        toolCalls.push(...repaired.toolCalls);
        fullText = repaired.cleanedText;
      }
    }

    if (toolCalls.length > 0) yield { type: 'tool_calls', toolCalls };

    yield {
      type: 'done',
      text: fullText,
      toolCalls,
      usage: {
        promptTokens,
        completionTokens,
        durationMs: Date.now() - started,
      },
    };
  }
}

/** Fail fast with a helpful message when Ollama is not up. */
export async function pingOllama(baseUrl: string): Promise<{
  ok: boolean;
  version?: string;
  models?: string[];
  error?: string;
}> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    return { ok: true, models: (json.models ?? []).map((m) => m.name) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
