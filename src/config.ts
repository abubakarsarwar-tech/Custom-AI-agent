import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** How much the agent is allowed to do without asking you first. */
export type PermissionMode =
  | 'ask' // prompt before any write / shell command  (default, safest)
  | 'auto' // do everything, only hard-blocked commands are refused
  | 'readonly'; // analysis only: read/search allowed, no writes, no shell

export type ProviderName = 'ollama' | 'mock';

export interface AgentConfig {
  provider: ProviderName;
  /** Base URL of the local Ollama server. */
  ollamaUrl: string;
  /** Ollama model tag, e.g. "qwen2.5-coder:7b". */
  model: string;
  /** Context window handed to the model (Ollama defaults to only 2048/4096!). */
  numCtx: number;
  temperature: number;
  /** How long Ollama keeps weights in RAM between requests. */
  keepAlive: string;
  /** Everything the agent touches is jailed inside this directory. */
  workspace: string;
  /** Max think->tool->observe rounds before we force-stop. */
  maxSteps: number;
  permissionMode: PermissionMode;
  /** Refuse to read files larger than this. */
  maxFileBytes: number;
  /** Truncate any tool output longer than this. */
  maxOutputChars: number;
  bashTimeoutMs: number;
  /** Extra tool names auto-approved even in "ask" mode. */
  autoApprove: string[];
  /** Contents of AGENTS.md / custom rules injected into the system prompt. */
  customInstructions: string;
  /** Modular expertise (design/code/debug...). Only names+descriptions enter the prompt. */
  skillsEnabled: boolean;
  /** Auto-load the best-matching skill instead of spending a round-trip asking the model. */
  skillsAutoRoute: boolean;
  /** Extra folders to search for SKILL.md files. */
  skillsDirs: string[];
  /** Cap on how much of one skill body may enter the context. */
  skillsMaxBodyChars: number;
  /** Remember corrections and conventions across sessions (.agent/memory/lessons.jsonl). */
  memoryEnabled: boolean;
  /** Max remembered facts injected into a single turn. */
  memoryMaxInject: number;
  /** Snapshot files before the agent changes them, so a turn can be rolled back. */
  checkpointsEnabled: boolean;
  /** Let the agent delegate to a sub-agent that gets its own context window. */
  subagentsEnabled: boolean;
  /** Step cap for one sub-agent. Always clamped to maxSteps as well. */
  subagentMaxSteps: number;
  /** Hard cap on the report that comes back into the parent's context. */
  subagentReportChars: number;
  /** How many turn-checkpoints to keep before pruning the oldest. */
  checkpointsKeep: number;
  /** Where conversation history + logs are persisted. */
  stateDir: string;
  /** `lca serve`: interface to bind. 127.0.0.1 keeps the web UI private to this machine. */
  serveHost: string;
  /** `lca serve`: port for the web UI + HTTP API. */
  servePort: number;
  /** Shared secret for /api/*. Empty = no auth (only safe on loopback). */
  serveToken: string;
  /** Folder of static files to serve. Empty = the bundled web/ directory. */
  webDir: string;
}

export const DEFAULT_CONFIG: AgentConfig = {
  provider: 'ollama',
  ollamaUrl: 'http://127.0.0.1:11434',
  model: 'qwen2.5-coder:7b',
  numCtx: 8192,
  temperature: 0.1,
  keepAlive: '20m',
  workspace: process.cwd(),
  maxSteps: 25,
  permissionMode: 'ask',
  maxFileBytes: 1_000_000,
  maxOutputChars: 24_000,
  bashTimeoutMs: 120_000,
  autoApprove: [],
  customInstructions: '',
  stateDir: '.agent',
  skillsEnabled: true,
  skillsAutoRoute: true,
  skillsDirs: [],
  skillsMaxBodyChars: 12000,
  memoryEnabled: true,
  memoryMaxInject: 5,
  checkpointsEnabled: true,
  checkpointsKeep: 20,
  subagentsEnabled: true,
  subagentMaxSteps: 12,
  subagentReportChars: 4000,
  serveHost: '127.0.0.1',
  servePort: 8787,
  serveToken: '',
  webDir: '',
};

const ENV_MAP: Record<string, keyof AgentConfig> = {
  LCA_PROVIDER: 'provider',
  LCA_OLLAMA_URL: 'ollamaUrl',
  LCA_MODEL: 'model',
  LCA_NUM_CTX: 'numCtx',
  LCA_TEMPERATURE: 'temperature',
  LCA_KEEP_ALIVE: 'keepAlive',
  LCA_MAX_STEPS: 'maxSteps',
  LCA_PERMISSION_MODE: 'permissionMode',
  LCA_WORKSPACE: 'workspace',
  LCA_BASH_TIMEOUT_MS: 'bashTimeoutMs',
  LCA_SKILLS: 'skillsEnabled',
  LCA_SKILLS_AUTO: 'skillsAutoRoute',
  LCA_SKILLS_DIRS: 'skillsDirs',
  LCA_SKILLS_MAX_BODY: 'skillsMaxBodyChars',
  LCA_MEMORY: 'memoryEnabled',
  LCA_MEMORY_MAX_INJECT: 'memoryMaxInject',
  LCA_CHECKPOINTS: 'checkpointsEnabled',
  LCA_CHECKPOINTS_KEEP: 'checkpointsKeep',
  LCA_SUBAGENTS: 'subagentsEnabled',
  LCA_SUBAGENT_MAX_STEPS: 'subagentMaxSteps',
  LCA_SUBAGENT_REPORT_CHARS: 'subagentReportChars',
  LCA_WEB_HOST: 'serveHost',
  LCA_WEB_PORT: 'servePort',
  LCA_WEB_TOKEN: 'serveToken',
  LCA_WEB_DIR: 'webDir',
};

const NUMERIC: Array<keyof AgentConfig> = [
  'numCtx',
  'temperature',
  'maxSteps',
  'maxFileBytes',
  'maxOutputChars',
  'bashTimeoutMs',
  'skillsMaxBodyChars',
  'memoryMaxInject',
  'checkpointsKeep',
  'subagentMaxSteps',
  'subagentReportChars',
  'servePort',
];

const ARRAYS: Array<keyof AgentConfig> = ['autoApprove', 'skillsDirs'];
const BOOLEANS: Array<keyof AgentConfig> = [
  'skillsEnabled',
  'skillsAutoRoute',
  'memoryEnabled',
  'checkpointsEnabled',
  'subagentsEnabled',
];

function coerce(key: keyof AgentConfig, raw: string): unknown {
  if (NUMERIC.includes(key)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (ARRAYS.includes(key)) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (BOOLEANS.includes(key)) return !['0', 'false', 'no', 'off', ''].includes(raw.trim().toLowerCase());
  return raw;
}

/** Look for a project config, then a user-level config. First hit wins. */
function findConfigFile(workspace: string): string | null {
  const candidates = [
    path.join(workspace, '.agent', 'config.json'),
    path.join(workspace, 'agent.config.json'),
    path.join(os.homedir(), '.config', 'local-code-agent', 'config.json'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** Load project rules the way Claude Code loads CLAUDE.md. */
export function loadCustomInstructions(workspace: string): string {
  for (const name of ['AGENTS.md', 'AGENT.md', '.lcarules', '.cursorrules']) {
    const p = path.join(workspace, name);
    if (existsSync(p)) {
      try {
        const body = readFileSync(p, 'utf8').trim();
        if (body) return `# Project rules (from ${name})\n${body}`;
      } catch {
        /* ignore unreadable rules file */
      }
    }
  }
  return '';
}

/**
 * Precedence: defaults < config file < environment < CLI flags (overrides).
 */
export function resolveConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const workspace = path.resolve(
    overrides.workspace ?? process.env.LCA_WORKSPACE ?? DEFAULT_CONFIG.workspace,
  );

  let cfg: AgentConfig = { ...DEFAULT_CONFIG, workspace };

  const file = findConfigFile(workspace);
  if (file) {
    try {
      const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(json)) {
        if (k in DEFAULT_CONFIG && v !== undefined) {
          (cfg as unknown as Record<string, unknown>)[k] = v;
        }
      }
    } catch {
      throw new Error(`Config file ${file} is not valid JSON`);
    }
  }

  for (const [envKey, cfgKey] of Object.entries(ENV_MAP)) {
    const raw = process.env[envKey];
    if (raw !== undefined && raw !== '') {
      (cfg as unknown as Record<string, unknown>)[cfgKey] = coerce(cfgKey, raw);
    }
  }

  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (cfg as unknown as Record<string, unknown>)[k] = v;
  }

  cfg.workspace = path.resolve(cfg.workspace);
  cfg.ollamaUrl = cfg.ollamaUrl.replace(/\/+$/, '');
  if (!cfg.customInstructions) cfg.customInstructions = loadCustomInstructions(cfg.workspace);
  cfg.stateDir = path.resolve(cfg.workspace, cfg.stateDir);

  return cfg;
}

export function redact(cfg: AgentConfig): Record<string, unknown> {
  return {
    provider: cfg.provider,
    model: cfg.model,
    ollamaUrl: cfg.ollamaUrl,
    numCtx: cfg.numCtx,
    temperature: cfg.temperature,
    workspace: cfg.workspace,
    maxSteps: cfg.maxSteps,
    permissionMode: cfg.permissionMode,
    serveHost: cfg.serveHost,
    servePort: cfg.servePort,
    serveToken: cfg.serveToken ? 'set' : 'none',
    checkpoints: cfg.checkpointsEnabled ? `on (keep ${cfg.checkpointsKeep})` : 'off',
    subagents: cfg.subagentsEnabled ? `on (max ${cfg.subagentMaxSteps} steps)` : 'off',
  };
}
