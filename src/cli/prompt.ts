import { createInterface, type Interface } from 'node:readline/promises';
import type { ActionRequest } from '../safety/permissions.js';
import { c } from '../util/ansi.js';
import type { Answer, UI } from '../ui/ui.js';

/**
 * Wires a real y/n/a terminal prompt into the UI's permission hook.
 * Shared by the REPL and one-shot mode so approval behaviour is identical.
 */
export function attachAsk(
  ui: UI,
  rl: Interface,
  hooks: { pause?: () => void; resume?: () => void } = {},
): void {
  ui.ask = async (req: ActionRequest): Promise<Answer> => {
    hooks.resume?.();
    ui.line('');
    ui.line(`  ${ui.renderRequest(req)}`);
    if (req.command) ui.line(c.dim(`  $ ${req.command}`));
    if (req.path) ui.line(c.dim(`  path: ${req.path}`));
    let answer = '';
    try {
      answer = await rl.question(c.yellow('  allow? [y]es / [n]o / [a]lways-for-this-tool > '));
    } catch {
      answer = 'n';
    }
    hooks.pause?.();
    const s = answer.trim().toLowerCase();
    if (s === 'y' || s === 'yes') return 'yes';
    if (s === 'a' || s === 'always') return 'always';
    return 'no';
  };
}

/** One-shot mode: build a throwaway readline just for approvals. */
export function attachStandaloneAsk(ui: UI): { close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  attachAsk(ui, rl);
  return { close: () => rl.close() };
}
