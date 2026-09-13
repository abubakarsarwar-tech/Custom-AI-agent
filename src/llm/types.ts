/** Shared shapes for the model layer. Modelled on the OpenAI/Ollama tool format. */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  /** Optional id; Ollama does not always give us one, so we synthesise it. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Original text, kept so we can show the user what the model emitted. */
  raw?: string;
  /** True when the call was reconstructed from free text rather than native tool calling. */
  repaired?: boolean;
}

export interface Message {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  /** Present on role:"tool" messages — which tool produced this result. */
  tool_name?: string;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export interface GenerateOptions {
  signal?: AbortSignal;
  temperature?: number;
  numCtx?: number;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_calls'; toolCalls: ToolCall[] }
  | { type: 'done'; text: string; toolCalls: ToolCall[]; usage: Usage }
  | { type: 'error'; error: string };

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export interface LLMProvider {
  readonly name: string;
  stream(
    messages: Message[],
    tools: ToolSpec[],
    opts?: GenerateOptions,
  ): AsyncGenerator<StreamEvent>;
}

let counter = 0;
export function nextCallId(): string {
  counter += 1;
  return `call_${Date.now().toString(36)}_${counter}`;
}
