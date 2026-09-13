import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import { OllamaProvider } from '../llm/ollama.js';
import type { AgentRuntime } from '../agent/runtime.js';
import { c } from '../util/ansi.js';
import { expandMentions } from './mentions.js';
import { attachAsk } from './prompt.js';
import { recommendModels } from '../doctor.js';

const PROMPT = `${c.bold(c.magenta('lca'))} ${c.cyan('❯')} `;

const HELP = `
${c.bold('Commands')}
  /help                  this list
  /model [tag]           show or switch model (e.g. /model qwen3:8b)
  /models                list models already pulled in Ollama
  /plan                  show the agent's current todo plan
  /tools                 list the tools the model can call
  /permissions [mode]    show or set mode: ask | auto | readonly
  /ctx                   show the environment block fed to the model
  /stats                 tokens, steps and timings for this session
  /compact               shrink history now (keeps a factual action log)
  /undo                  drop your last message and its replies
  /clear                 wipe history and start over
  /exit                  quit

${c.bold('Shortcuts')}
  ${'@path/to/file'}          attach a file to your message
  !git status            run a shell command directly, no model involved
  \\ at end of line       continue on the next line (multi-line input)
  Ctrl+C                 interrupt the current turn
`;

export async function startRepl(rt: AgentRuntime, initialPrompt?: string): Promise<number> {
  const ui = rt.ui;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  let busy = false;
  let ac: AbortController | null = null;

  /* ---- permission prompts, wired into the readline session ---- */
  attachAsk(ui, rl, { pause: () => rl.pause(), resume: () => rl.resume() });

  rl.on('SIGINT', () => {
    if (busy && ac) {
      ac.abort();
      ui.stopSpinner();
      ui.warn('interrupted — the turn was cancelled');
    } else {
      ui.dim('\nbye');
      rl.close();
    }
  });

  ui.banner('LCA · local code agent', [
    `model   ${rt.config.model}   (${rt.config.provider}, num_ctx ${rt.config.numCtx})`,
    `workspace ${rt.config.workspace}`,
    `mode    ${rt.config.permissionMode} · /help for commands · /exit to quit`,
    'runs 100% on this machine — nothing leaves your laptop',
  ]);

  if (initialPrompt) await handle(initialPrompt);

  for (;;) {
    let line: string;
    rl.resume();
    try {
      line = await rl.question(PROMPT);
    } catch {
      break; // Ctrl+D / closed
    }
    rl.pause();

    const trimmed = line.trim();
    if (!trimmed) continue;

    // multi-line continuation with a trailing backslash
    let full = trimmed;
    while (full.endsWith('\\')) {
      full = full.slice(0, -1);
      rl.resume();
      let more: string;
      try {
        more = await rl.question(c.dim('  … '));
      } catch {
        more = '';
      }
      rl.pause();
      full = `${full}\n${more}`;
      if (!more.trim()) break;
    }

    const done = await handle(full);
    if (done) break;
  }

  rl.close();
  ui.stopSpinner();
  return 0;

  /* ------------------------------------------------------------------ */

  async function handle(raw: string): Promise<boolean> {
    const input = raw.trim();
    if (!input) return false;

    if (input.startsWith('/')) return slash(input);

    if (input.startsWith('!')) {
      const command = input.slice(1).trim();
      if (!command) return false;
      const ac2 = new AbortController();
      const res = await rt.registry.invoke(
        'bash',
        { command },
        {
          workspace: rt.config.workspace,
          config: rt.config,
          permissions: rt.permissions,
          session: rt.session,
          ui,
          signal: ac2.signal,
        },
      );
      ui.line(res.content);
      return false;
    }

    busy = true;
    ac = new AbortController();
    try {
      const { text, attached, errors } = await expandMentions(input, rt.config.workspace, Math.min(
        rt.config.maxFileBytes,
        60_000,
      ));
      for (const e of errors) ui.warn(e);
      if (attached.length > 0) {
        ui.dim(`  attached: ${attached.map((a) => `${a.rel} (${a.lines} lines)`).join(', ')}`);
      }

      const result = await rt.send(text, ac.signal);

      if (result.hitMaxSteps) ui.warn('stopped at the step limit');
      if (!result.answer && !result.aborted) {
        ui.dim('  (the model produced no final text — see the tool trace above)');
      }
      ui.line('');
      ui.dim(`  ${rt.statsLine()}`);
      return false;
    } catch (err) {
      ui.error(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      busy = false;
      ac = null;
    }
  }

  async function slash(input: string): Promise<boolean> {
    const [cmdRaw, ...rest] = input.slice(1).split(/\s+/);
    const cmd = (cmdRaw ?? '').toLowerCase();
    const arg = rest.join(' ').trim();

    switch (cmd) {
      case 'help':
      case '?':
        ui.line(HELP);
        return false;

      case 'exit':
      case 'quit':
      case 'q':
        ui.dim('bye');
        return true;

      case 'model': {
        if (!arg) {
          ui.info(`current model: ${c.bold(rt.config.model)}`);
          const totalRamGb = os.totalmem() / 1024 ** 3;
          const recs = recommendModels(totalRamGb);
          ui.dim(
            `  best for this machine (${totalRamGb.toFixed(0)} GB RAM): ${recs.map((r) => r.tag).join(', ')}`,
          );
          ui.dim('  switch with: /model qwen3:8b');
          return false;
        }
        rt.setModel(arg);
        await settle(rt);
        ui.success(`model → ${arg}`);
        return false;
      }

      case 'models': {
        if (rt.provider instanceof OllamaProvider) {
          try {
            const list = await rt.provider.listModels();
            if (list.length === 0) ui.warn('no models pulled yet. Try: ollama pull qwen2.5-coder:7b');
            for (const m of list) {
              const mark = m.name.startsWith(rt.config.model.split(':')[0] ?? '') ? c.green('*') : ' ';
              ui.line(`  ${mark} ${m.name.padEnd(34)} ${(m.size / 1024 ** 3).toFixed(1)} GB`);
            }
          } catch (err) {
            ui.error(`could not list models: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          ui.warn('the mock provider has no model list');
        }
        return false;
      }

      case 'plan': {
        ui.line(rt.session.plan.render());
        return false;
      }

      case 'tools': {
        for (const t of rt.registry.list()) {
          ui.line(`  ${c.bold(t.name.padEnd(12))} ${c.dim(`[${t.risk}]`)} ${t.description.split('.')[0]}.`);
        }
        return false;
      }

      case 'permissions': {
        if (!arg) {
          ui.info(`mode: ${c.bold(rt.config.permissionMode)}`);
          ui.dim('  ask = confirm writes and shell · auto = never ask · readonly = no changes allowed');
          ui.dim(`  always-allowed this session: ${[...rt.session.alwaysAllowed].join(', ') || '(none)'}`);
          return false;
        }
        if (!['ask', 'auto', 'readonly'].includes(arg)) {
          ui.error('usage: /permissions ask|auto|readonly');
          return false;
        }
        rt.setPermissionMode(arg as 'ask' | 'auto' | 'readonly');
        await settle(rt);
        ui.success(`permission mode → ${arg}`);
        return false;
      }

      case 'ctx': {
        ui.line(c.dim(rt.repoContext));
        if (rt.config.customInstructions) {
          ui.line('');
          ui.line(c.dim(rt.config.customInstructions.slice(0, 2000)));
        }
        return false;
      }

      case 'stats': {
        ui.line(`  ${rt.statsLine()}`);
        return false;
      }

      case 'compact': {
        const r = rt.compactNow();
        ui.success(`history compacted: ${r.dropped} messages dropped`);
        return false;
      }

      case 'clear': {
        rt.clearHistory();
        ui.success('history cleared');
        return false;
      }

      case 'undo': {
        ui.info(rt.undoLast() ? 'last exchange removed' : 'nothing to undo');
        return false;
      }

      default:
        ui.error(`unknown command "/${cmd}". Type /help.`);
        return false;
    }
  }
}

/** setModel/setPermissionMode are sync; the prompt rebuild is async, so await it. */
async function settle(rt: AgentRuntime): Promise<void> {
  await rt.refreshContext();
}
