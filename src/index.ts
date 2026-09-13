#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { resolveConfig, redact, type AgentConfig } from './config.js';
import { helpText, parseArgs } from './cli/args.js';
import { startRepl } from './cli/repl.js';
import { attachStandaloneAsk } from './cli/prompt.js';
import { AgentRuntime } from './agent/runtime.js';
import { MockProvider, demoScript, sloppyScript, webScript } from './llm/mock.js';
import { OllamaProvider, pingOllama } from './llm/ollama.js';
import { UI } from './ui/ui.js';
import { SkillLibrary } from './skills/library.js';
import { c } from './util/ansi.js';
import { runDoctor } from './doctor.js';
import { BUNDLED_WEB_DIR, generateToken, startServer } from './server/http.js';

type MockScript = 'demo' | 'sloppy' | 'web';

function mockProvider(script: MockScript = 'demo'): MockProvider {
  if (script === 'sloppy') return new MockProvider(sloppyScript());
  // The web tour loops and paces itself so the browser demo stays usable.
  if (script === 'web') return new MockProvider(webScript(), { loop: true, delayMs: 6 });
  return new MockProvider(demoScript());
}

async function buildRuntime(
  cfg: AgentConfig,
  ui: UI,
  mockScript?: MockScript,
): Promise<AgentRuntime> {
  const script: MockScript = mockScript ?? 'demo';
  const provider = cfg.provider === 'mock' ? mockProvider(script) : OllamaProvider.fromConfig(cfg);

  return AgentRuntime.create({
    ui,
    config: cfg,
    provider,
    factory: (c) => (c.provider === 'mock' ? mockProvider(script) : OllamaProvider.fromConfig(c)),
  });
}

// `lca run "..." | head` closes the pipe early; that is normal, not a crash.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(helpText());
    return 0;
  }

  const ui = new UI({
    quiet: args.quiet,
    verbose: args.verbose,
    interactive: args.command === 'repl',
  });

  // The demo writes real files, so give it a throwaway folder unless the user
  // pointed it somewhere specific with -w. Created before resolveConfig so the
  // verbose config dump shows the real workspace.
  let demoDir: string | undefined;
  if (args.command === 'demo' && !args.overrides.workspace) {
    demoDir = await mkdtemp(path.join(os.tmpdir(), 'lca-demo-'));
  }

  const cfg = resolveConfig({
    ...(demoDir ? { workspace: demoDir } : {}),
    ...args.overrides,
    ...(args.mockScript || args.command === 'demo' ? { provider: 'mock' as const } : {}),
    ...(args.command === 'demo' && !args.overrides.permissionMode
      ? { permissionMode: 'auto' as const }
      : {}),
  });

  if (args.verbose) ui.dim(`config: ${JSON.stringify(redact(cfg))}`);

  switch (args.command) {
    case 'help':
      process.stdout.write(helpText());
      return 0;

    case 'doctor':
      return runDoctor(cfg);

    case 'models': {
      const provider = OllamaProvider.fromConfig(cfg);
      const ping = await pingOllama(cfg.ollamaUrl);
      if (!ping.ok) {
        ui.error(`Ollama is not reachable at ${cfg.ollamaUrl} (${ping.error})`);
        ui.dim('start it with:  ollama serve');
        return 1;
      }
      const models = await provider.listModels();
      if (models.length === 0) {
        ui.warn('no models pulled yet.');
        ui.dim('try:  ollama pull qwen2.5-coder:7b');
        return 0;
      }
      ui.line(c.bold(`Models available at ${cfg.ollamaUrl}:`));
      for (const m of models) {
        const active = m.name === cfg.model || m.name.startsWith(`${cfg.model.split(':')[0]}:`);
        ui.line(
          `  ${active ? c.green('*') : ' '} ${m.name.padEnd(36)} ${c.dim(
            `${(m.size / 1024 ** 3).toFixed(1)} GB`,
          )}`,
        );
      }
      ui.dim(`\nactive: ${cfg.model} — switch with -m <tag> or /model <tag>`);
      return 0;
    }

    case 'skills': {
      const lib = await SkillLibrary.create(cfg.workspace, {
        enabled: true,
        extraDirs: cfg.skillsDirs,
        maxBodyChars: cfg.skillsMaxBodyChars,
      });
      ui.line(c.bold(`Skills available (${lib.count}):`));
      ui.line('');
      ui.line(lib.renderTable());
      ui.line('');
      ui.dim('  * = already loaded in this session');
      ui.dim(`  auto-route: ${cfg.skillsAutoRoute ? 'on' : 'off'} · body cap: ${cfg.skillsMaxBodyChars} chars`);
      ui.line('');
      ui.line(c.bold('Searched, in override order:'));
      for (const d of lib.searchedFrom) {
        ui.line(c.dim(`  ${d}`));
      }
      if (lib.problems.length > 0) {
        ui.line('');
        ui.line(c.bold('Notes:'));
        for (const p of lib.problems) ui.line(c.dim(`  ${p}`));
      }
      ui.line('');
      ui.dim('Add your own: create <project>/.agent/skills/<name>/SKILL.md — see skills/code/SKILL.md for the format.');
      return 0;
    }

    case 'demo':
    case 'run': {
      const isDemo = args.command === 'demo';

      if (isDemo && demoDir) ui.info(`demo workspace: ${demoDir}`);

      const prompt = isDemo
        ? args.prompt || "Create a file hello.txt containing 'it works', then read it back to me."
        : args.prompt;

      const rt = await buildRuntime(cfg, ui, args.mockScript);

      if (!isDemo && cfg.provider === 'ollama') {
        const ping = await pingOllama(cfg.ollamaUrl);
        if (!ping.ok) {
          ui.error(`Cannot reach Ollama at ${cfg.ollamaUrl}: ${ping.error}`);
          ui.dim('Fix: run "ollama serve" in another terminal, then try again. Or "lca doctor".');
          return 1;
        }
        if (!(ping.models ?? []).some((m) => m === cfg.model || m.startsWith(`${cfg.model.split(':')[0]}:`))) {
          ui.warn(`model "${cfg.model}" is not pulled yet`);
          ui.dim(`Fix: ollama pull ${cfg.model}`);
          return 1;
        }
      }

      // Approvals in one-shot mode: prompt for real when attached to a TTY,
      // otherwise say loudly that mutating tools will be refused.
      let askHandle: { close: () => void } | null = null;
      if (cfg.permissionMode === 'ask' && process.stdin.isTTY) {
        askHandle = attachStandaloneAsk(ui);
      } else if (cfg.permissionMode === 'ask') {
        ui.warn(
          'permission mode is "ask" but this is not an interactive terminal — ' +
            'write_file / edit_file / bash will be REFUSED.',
        );
        ui.dim('  re-run with --yolo to let the agent act unattended, or use the REPL (lca).');
      }

      const ac = new AbortController();
      const onSig = (): void => ac.abort();
      process.on('SIGINT', onSig);
      process.on('SIGTERM', onSig);

      if (args.skill) {
        if (rt.preloadSkill(args.skill)) ui.success(`skill loaded: ${args.skill}`);
        else ui.warn(`no skill called "${args.skill}" — try: lca skills`);
      }

      if (isDemo) {
        ui.banner('LCA demo (mock provider — no model needed)', [
          'This replays a scripted model to prove the agent loop,',
          'the permission gate and the file tools all work end to end.',
        ]);
      }

      const result = await rt.send(prompt, ac.signal);

      askHandle?.close();
      process.off('SIGINT', onSig);
      process.off('SIGTERM', onSig);
      ui.stopSpinner();
      ui.endAssistant();

      if (!args.quiet) {
        ui.line('');
        ui.dim(`  ${rt.statsLine()}`);
      }
      if (result.error) {
        ui.error(result.error);
        return 1;
      }
      return result.aborted ? 130 : 0;
    }

    case 'serve': {
      const loopback = ['127.0.0.1', 'localhost', '::1'].includes(cfg.serveHost);
      // A web agent can run shell commands. Binding off-loopback with no secret
      // would hand that to the whole network, so we mint one instead.
      const token = cfg.serveToken || (loopback || args.publicNoAuth ? '' : generateToken());
      const webDir = cfg.webDir ? path.resolve(cfg.webDir) : BUNDLED_WEB_DIR;

      if (cfg.provider === 'ollama') {
        const ping = await pingOllama(cfg.ollamaUrl);
        if (!ping.ok) {
          ui.warn(`Ollama is not reachable at ${cfg.ollamaUrl} (${ping.error})`);
          ui.dim('the web UI will still open and say so — start Ollama, then refresh. Or run: lca doctor');
        } else if (!(ping.models ?? []).some((m) => m === cfg.model || m.startsWith(`${cfg.model.split(':')[0]}:`))) {
          ui.warn(`model "${cfg.model}" is not pulled yet — pick another in the web UI`);
          ui.dim(`fix: ollama pull ${cfg.model}`);
        }
      }

      // No Ollama in this shell? The scripted web tour still exercises the whole UI.
      const rt = await buildRuntime(
        cfg,
        ui,
        args.mockScript ?? (cfg.provider === 'mock' ? 'web' : undefined),
      );
      if (args.skill && rt.preloadSkill(args.skill)) ui.success(`skill loaded: ${args.skill}`);

      let started: Awaited<ReturnType<typeof startServer>>;
      try {
        started = await startServer(rt, {
          host: cfg.serveHost,
          port: cfg.servePort,
          webDir,
          ...(token ? { token } : {}),
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'EADDRINUSE') {
          ui.error(`port ${cfg.servePort} is already in use`);
          ui.dim(`fix: lca serve --port ${cfg.servePort + 1}`);
          return 1;
        }
        throw err;
      }

      const openUrl = token ? `${started.url}?token=${token}` : started.url;
      ui.line('');
      ui.banner('LCA web UI', [
        `  ${c.bold(openUrl)}`,
        '',
        `  workspace   ${cfg.workspace}`,
        `  model       ${cfg.model} (${cfg.provider})`,
        `  permissions ${cfg.permissionMode}`,
        `  web files   ${webDir}`,
        ...(token ? [`  token       ${token}`] : []),
        '',
        '  The HTTP API is on the same port: GET /api/state, POST /api/chat,',
        '  GET /api/events (SSE). Press Ctrl+C to stop.',
      ]);
      ui.line('');
      if (token) ui.dim(`open the URL above as-is — it carries the token. The UI stores it in localStorage.`);

      // Keep the process alive and shut down cleanly.
      await new Promise<void>((resolve) => {
        const stop = (sig: string): void => {
          ui.line('');
          ui.dim(`${sig} — shutting down`);
          void started.close().then(resolve, resolve);
        };
        process.once('SIGINT', () => stop('SIGINT'));
        process.once('SIGTERM', () => stop('SIGTERM'));
      });
      return 0;
    }

    case 'repl':
    default: {
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      if (!interactive) ui.warn('stdin is not a TTY — running one-shot instead. Use "lca run \\"task\\"".');

      if (cfg.provider === 'ollama') {
        const ping = await pingOllama(cfg.ollamaUrl);
        if (!ping.ok) {
          ui.error(`Cannot reach Ollama at ${cfg.ollamaUrl}: ${ping.error}`);
          ui.line('');
          ui.line(c.bold('To fix:'));
          ui.line('  1. install Ollama      https://ollama.com/download');
          ui.line('  2. start the server    ollama serve');
          ui.line(`  3. pull a model        ollama pull ${cfg.model}`);
          ui.line('  4. re-check            lca doctor');
          ui.line('');
          ui.dim('Want to see the agent work with no model at all? Run:  lca demo');
          return 1;
        }
      }

      const rt = await buildRuntime(cfg, ui, args.mockScript);
      ui.nonInteractiveAnswer = 'no';
      if (args.skill) {
        if (rt.preloadSkill(args.skill)) ui.success(`skill loaded: ${args.skill}`);
        else ui.warn(`no skill called "${args.skill}" — try: lca skills`);
      }
      return startRepl(rt, args.prompt || undefined);
    }
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`\n${c.red('fatal:')} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
