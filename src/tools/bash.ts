import { spawn } from 'node:child_process';
import { truncate } from '../safety/paths.js';
import { fail, int, ok, str, type Tool, type ToolContext, type ToolResult } from './types.js';

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
}

function exec(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', GIT_PAGER: 'cat', PAGER: 'cat' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;

    const cap = (chunk: Buffer, current: string): string => {
      if (current.length >= maxBytes) return current;
      return current + chunk.toString('utf8').slice(0, Math.max(0, maxBytes - current.length));
    };

    child.stdout?.on('data', (d: Buffer) => {
      stdout = cap(d, stdout);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr = cap(d, stderr);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          killed = true;
          child.kill('SIGKILL');
        }
      }, 2000);
    }, timeoutMs);

    const onAbort = (): void => {
      killed = true;
      child.kill('SIGTERM');
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ exitCode: 127, stdout, stderr: `${stderr}\n${err.message}`.trim(), timedOut, killed });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut, killed });
    });
  });
}

export const bashTool: Tool = {
  name: 'bash',
  description:
    'Run a shell command in the workspace and return stdout, stderr and the exit code. ' +
    'Use it for git, npm/pnpm, pytest, tsc, ls, building and running tests. ' +
    'IMPORTANT: every call is a fresh shell — cd and exported env vars do NOT persist, so chain with "&&". ' +
    'Never use it to start long-lived dev servers or watchers; run one-shot commands only.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      cwd: { type: 'string', description: 'Subdirectory to run in (default: workspace root).' },
      timeout_ms: { type: 'number', description: 'Kill the command after this many ms (default 120000).' },
    },
    required: ['command'],
  },
  risk: 'high',

  summarize: (args) => `$ ${str(args, 'command').replace(/\s+/g, ' ').slice(0, 140)}`,

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = str(args, 'command').trim();
    if (!command) return fail('bash requires a "command".');

    const sub = str(args, 'cwd').trim();
    const workdir = sub ? `${ctx.workspace}/${sub.replace(/^\.?\//, '')}` : ctx.workspace;
    const timeoutMs = Math.min(600_000, Math.max(1_000, int(args, 'timeout_ms', ctx.config.bashTimeoutMs)));

    const verdict = await ctx.permissions.check({
      tool: this.name,
      summary: this.summarize(args),
      risk: this.risk,
      command,
    });
    if (!verdict.allowed) {
      return fail(
        `Command not run: ${verdict.reason}\n` +
          'Tell the user what you wanted to run and ask them to run it themselves, or find another way.',
      );
    }

    const started = Date.now();
    const result = await exec(command, workdir, timeoutMs, ctx.config.maxOutputChars * 4, ctx.signal);
    const ms = Date.now() - started;

    const stdout = truncate(result.stdout.replace(/\s+$/, ''), ctx.config.maxOutputChars, 'stdout');
    const stderr = truncate(result.stderr.replace(/\s+$/, ''), ctx.config.maxOutputChars / 2, 'stderr');

    const parts: string[] = [`exit code: ${result.exitCode} (${ms}ms)`];
    if (result.timedOut) parts.push(`TIMED OUT after ${timeoutMs}ms — the process was killed.`);
    if (result.killed && !result.timedOut) parts.push('Process was interrupted.');
    if (stdout) parts.push(`--- stdout ---\n${stdout}`);
    if (stderr) parts.push(`--- stderr ---\n${stderr}`);
    if (!stdout && !stderr) parts.push('(no output)');

    ctx.ui.toolDetail(`exit ${result.exitCode} in ${ms}ms`);

    return ok(parts.join('\n'), {
      isError: result.exitCode !== 0,
      data: { exitCode: result.exitCode, ms, timedOut: result.timedOut },
    });
  },
};
