/**
 * Local models are much worse at native function calling than Claude or GPT.
 * Half the time they "call a tool" by just printing JSON inside their answer.
 *
 * This module recovers those tool calls so the agent keeps working instead of
 * silently doing nothing. This single file is the difference between a demo
 * and an agent that actually survives real-world local models.
 */
import { nextCallId, type ToolCall } from './types.js';

const KNOWN_ARG_KEYS = [
  'path',
  'file_path',
  'filename',
  'content',
  'text',
  'old_text',
  'new_text',
  'replace_all',
  'command',
  'cmd',
  'pattern',
  'regex',
  'glob',
  'offset',
  'limit',
  'depth',
  'todos',
  'summary',
  'case_sensitive',
];

interface RawCall {
  name?: string;
  args?: unknown;
}

function normaliseName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^[^a-zA-Z_]+/, '').replace(/\s+/g, '_');
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cleaned) ? cleaned : null;
}

function normaliseArgs(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    // Some models emit the arguments as a JSON *string* instead of an object.
    try {
      return normaliseArgs(JSON.parse(raw));
    } catch {
      return { content: raw };
    }
  }
  if (Array.isArray(raw)) {
    const first = raw[0];
    if (first && typeof first === 'object') return normaliseArgs(first);
    return {};
  }
  if (typeof raw !== 'object') return {};

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim().replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    if (KNOWN_ARG_KEYS.includes(key) || key.length <= 24) out[key] = v;
  }
  return out;
}

/** Extract balanced JSON objects from a blob of text without a real parser pass. */
function extractJsonObjects(text: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          found.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return found;
}

function tryParse(raw: string): RawCall | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const nameCandidate =
      obj.name ?? obj.tool ?? obj.tool_name ?? obj.function_name ??
      (obj.function && typeof obj.function === 'object'
        ? (obj.function as Record<string, unknown>).name
        : undefined);
    const name = normaliseName(nameCandidate);
    if (!name) return null;

    let args: unknown =
      obj.arguments ?? obj.args ?? obj.parameters ?? obj.params ?? obj.input ?? obj.function;
    if (args && typeof args === 'object' && !Array.isArray(args) && 'name' in (args as object)) {
      args = (args as Record<string, unknown>).arguments ?? {};
    }
    return { name, args };
  } catch {
    return null;
  }
}

/**
 * Pull tool calls out of plain assistant text.
 * Recognises: fenced ```json blocks, bare JSON objects, and
 * `{"name": "...", "arguments": {...}}` shapes.
 */
export function repairToolCalls(text: string, allowed: Set<string>): {
  toolCalls: ToolCall[];
  cleanedText: string;
} {
  if (!text || !text.includes('{')) return { toolCalls: [], cleanedText: text };

  const calls: ToolCall[] = [];
  const consumed = new Set<string>();

  for (const candidate of extractJsonObjects(text)) {
    const parsed = tryParse(candidate);
    if (!parsed?.name) continue;
    if (!allowed.has(parsed.name)) continue; // random JSON in prose is not a tool call
    calls.push({
      id: nextCallId(),
      name: parsed.name,
      arguments: normaliseArgs(parsed.args),
      raw: candidate,
      repaired: true,
    });
    consumed.add(candidate);
  }

  let cleanedText = text;
  if (calls.length > 0) {
    // Strip the JSON we acted on so it is not shown twice to the user.
    for (const chunk of consumed) cleanedText = cleanedText.replace(chunk, '');
    cleanedText = cleanedText
      .replace(/```(?:json|tool_call|function)?\s*```/g, '')
      .replace(/^\s*```\s*$/gm, '')
      .trim();
  }

  return { toolCalls: calls, cleanedText };
}

/** Repair malformed arguments coming from native tool calls. */
export function coerceNativeToolCalls(raw: unknown): Array<{ name: string; args: Record<string, unknown> }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const fn = (entry as Record<string, unknown>).function as Record<string, unknown> | undefined;
    const src = fn ?? (entry as Record<string, unknown>);
    const name = normaliseName(src?.name);
    if (!name) continue;
    out.push({ name, args: normaliseArgs(src?.arguments) });
  }
  return out;
}

/**
 * Very small models sometimes emit an almost-JSON string (trailing commas,
 * single quotes, unquoted keys). Try to salvage it before giving up.
 */
export function lenientJsonParse(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  const attempts = [
    raw.replace(/,\s*([}\]])/g, '$1'), // trailing commas
    raw.replace(/'/g, '"'), // single quotes
    raw.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":'), // bare keys
  ];
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* keep trying */
    }
  }
  return null;
}
