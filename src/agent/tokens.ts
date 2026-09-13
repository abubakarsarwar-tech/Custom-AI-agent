import type { Message } from '../llm/types.js';

/**
 * Local models rarely expose a real tokenizer over HTTP, and pulling one in
 * would add a dependency. chars/3.5 is a safe over-estimate for source code
 * (English prose is closer to /4, code has more short symbols).
 * Over-estimating is the right bias: we compact slightly early instead of
 * blowing the context window and getting a truncated, incoherent reply.
 */
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessages(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content ?? '') + 4; // per-message framing overhead
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += estimateTokens(tc.name) + estimateTokens(JSON.stringify(tc.arguments)) + 8;
      }
    }
  }
  return total;
}

export function estimateToolSpecs(specs: unknown[]): number {
  return estimateTokens(JSON.stringify(specs ?? []));
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
