import type { PermissionMode } from '../config.js';
import type { SessionState } from '../util/session.js';

export type Risk = 'low' | 'medium' | 'high';

export interface ActionRequest {
  tool: string;
  /** One-line human summary shown in the approval prompt. */
  summary: string;
  risk: Risk;
  command?: string;
  path?: string;
  sensitivePath?: boolean;
}

export type Decision = 'allow' | 'deny';

export interface Prompter {
  confirm(request: ActionRequest): Promise<'yes' | 'no' | 'always'>;
  note(text: string): void;
}

/** Commands that are never run, in any mode, including --yolo. */
const HARD_DENY: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+\/(\s|$)/i, why: 'recursive delete of the filesystem root' },
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+~\/?(\s|$)/i, why: 'recursive delete of your home directory' },
  { re: /\bmkfs(\.|\s)/i, why: 'formats a disk' },
  { re: /\bdd\s+if=.*of=\/dev\//i, why: 'raw write to a block device' },
  { re: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/, why: 'fork bomb' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: 'changes machine power state' },
  { re: /\bsudo\b/i, why: 'privilege escalation — run it yourself if you really need it' },
  { re: /\bcurl\b[^|]*\|\s*(ba)?sh\b/i, why: 'piping a remote script straight into a shell' },
  { re: /\bwget\b[^|]*\|\s*(ba)?sh\b/i, why: 'piping a remote script straight into a shell' },
  { re: /\bgit\s+push\b[^\n]*(--force|-f)\b/i, why: 'force push rewrites shared history' },
  { re: /\bchmod\s+(-[a-z]+\s+)*777\s+\//i, why: 'world-writable root path' },
  { re: />\s*\/etc\/(passwd|shadow|sudoers)/i, why: 'writing to a protected system file' },
];

/** Writes to these paths still need an explicit yes even in auto mode. */
const SENSITIVE_WRITE = /(^|[\\/])(\.env|\.env\.[a-z]+|\.ssh[\\/]|\.git[\\/])/i;

export class PermissionGate {
  constructor(
    private mode: PermissionMode,
    private readonly session: SessionState,
    private readonly prompter: Prompter,
  ) {}

  get permissionMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** Pure policy check — no user interaction. Exposed for tests. */
  evaluate(req: ActionRequest): { decision: Decision; reason: string; needsPrompt: boolean } {
    if (req.command) {
      for (const rule of HARD_DENY) {
        if (rule.re.test(req.command)) {
          return { decision: 'deny', reason: `Blocked: ${rule.why}`, needsPrompt: false };
        }
      }
    }

    if (this.mode === 'readonly' && (req.risk === 'high' || isMutating(req.tool))) {
      return {
        decision: 'deny',
        reason: `Read-only mode: "${req.tool}" can change things. Use /permissions auto to allow it.`,
        needsPrompt: false,
      };
    }

    const sensitiveWrite =
      req.risk !== 'low' && req.path !== undefined && SENSITIVE_WRITE.test(req.path);
    if (req.sensitivePath || sensitiveWrite) {
      return {
        decision: 'allow',
        reason: 'Sensitive path — explicit approval required',
        needsPrompt: true,
      };
    }

    if (this.mode === 'auto') {
      return { decision: 'allow', reason: 'auto mode', needsPrompt: false };
    }

    if (req.risk === 'low' || this.session.alwaysAllowed.has(req.tool)) {
      return { decision: 'allow', reason: 'pre-approved', needsPrompt: false };
    }
    if (req.command && this.session.approvedCommands.has(req.command)) {
      return { decision: 'allow', reason: 'command already approved this session', needsPrompt: false };
    }

    return { decision: 'allow', reason: 'needs approval', needsPrompt: true };
  }

  async check(req: ActionRequest): Promise<{ allowed: boolean; reason: string }> {
    const verdict = this.evaluate(req);
    if (!verdict.needsPrompt) {
      if (verdict.decision === 'deny') this.prompter.note(`denied ${req.tool}: ${verdict.reason}`);
      return { allowed: verdict.decision === 'allow', reason: verdict.reason };
    }

    const answer = await this.prompter.confirm(req);
    if (answer === 'always') {
      this.session.alwaysAllowed.add(req.tool);
      if (req.command) this.session.approvedCommands.add(req.command);
      return { allowed: true, reason: 'approved (always, this session)' };
    }
    if (answer === 'yes') {
      if (req.command) this.session.approvedCommands.add(req.command);
      return { allowed: true, reason: 'approved once' };
    }
    return { allowed: false, reason: 'denied by user' };
  }
}

export const READONLY_TOOLS = new Set(['read_file', 'list_dir', 'search', 'todo_write', 'report']);
export const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'bash', 'delete_file']);

export function isMutating(tool: string): boolean {
  return MUTATING_TOOLS.has(tool) || !READONLY_TOOLS.has(tool);
}

export function explainHardDeny(command: string): string | null {
  for (const rule of HARD_DENY) {
    if (rule.re.test(command)) return rule.why;
  }
  return null;
}
