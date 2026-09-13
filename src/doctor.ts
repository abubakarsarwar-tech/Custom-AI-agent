import os from 'node:os';
import { execFile } from 'node:child_process';
import { pingOllama } from './llm/ollama.js';
import type { AgentConfig } from './config.js';
import { c } from './util/ansi.js';

export interface ModelTier {
  tag: string;
  /** Total system RAM (GB) you realistically need free to run it. */
  minRamGb: number;
  approxDownloadGb: number;
  /** Does Ollama advertise native tool calling for this family? */
  nativeTools: boolean;
  note: string;
}

/**
 * Ordered cheapest-first. nativeTools matters a LOT for an agent: with it the
 * model emits structured calls; without it we fall back to parsing JSON out of
 * prose (src/llm/repair.ts), which works but drops calls more often.
 */
export const MODEL_TIERS: ModelTier[] = [
  { tag: 'qwen2.5-coder:1.5b', minRamGb: 3, approxDownloadGb: 1.0, nativeTools: false, note: 'tiny, fast, autocomplete-grade only' },
  { tag: 'qwen2.5-coder:3b', minRamGb: 5, approxDownloadGb: 2.0, nativeTools: false, note: 'small single-file edits' },
  { tag: 'qwen3:4b', minRamGb: 7, approxDownloadGb: 2.5, nativeTools: true, note: 'cheap + native tool calling' },
  { tag: 'qwen2.5-coder:7b', minRamGb: 10, approxDownloadGb: 4.7, nativeTools: false, note: 'best budget coder, no native tools (uses repair mode)' },
  { tag: 'qwen3:8b', minRamGb: 12, approxDownloadGb: 5.0, nativeTools: true, note: 'best 8GB-class agent model: native tools' },
  { tag: 'deepseek-r1:14b', minRamGb: 18, approxDownloadGb: 9.0, nativeTools: false, note: 'strong reasoning/debugging, slow' },
  { tag: 'qwen2.5-coder:14b', minRamGb: 20, approxDownloadGb: 9.0, nativeTools: false, note: 'solid multi-file coder' },
  { tag: 'gpt-oss:20b', minRamGb: 24, approxDownloadGb: 13.0, nativeTools: true, note: 'MoE, fast for its size, native tools' },
  { tag: 'devstral-small:24b', minRamGb: 26, approxDownloadGb: 15.0, nativeTools: true, note: 'trained specifically for agent loops' },
  { tag: 'qwen3-coder:30b', minRamGb: 32, approxDownloadGb: 18.0, nativeTools: true, note: 'best local coding agent model (30B MoE, ~3B active)' },
  { tag: 'qwen2.5-coder:32b', minRamGb: 40, approxDownloadGb: 20.0, nativeTools: false, note: 'strongest dense coder, needs a big machine' },
];

export function recommendModels(totalRamGb: number): ModelTier[] {
  // Leave ~25% of RAM for the OS, browser, editor and the KV cache.
  const usable = totalRamGb * 0.75;
  const viable = MODEL_TIERS.filter((m) => m.minRamGb <= usable);
  if (viable.length === 0) return MODEL_TIERS.slice(0, 1);
  // Best native-tools pick and best overall pick, newest/largest first.
  const top = viable[viable.length - 1] as ModelTier;
  const topTools = [...viable].reverse().find((m) => m.nativeTools);
  return topTools && topTools.tag !== top.tag ? [topTools, top] : [top];
}

function runBin(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, out: (stderr || err.message).trim() });
      else resolve({ ok: true, out: stdout.trim() });
    });
  });
}

interface Check {
  label: string;
  state: 'pass' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

export async function runDoctor(cfg: AgentConfig): Promise<number> {
  const checks: Check[] = [];
  const totalRamGb = os.totalmem() / 1024 ** 3;

  // 1. Node version
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    label: 'Node.js runtime',
    state: nodeMajor >= 18 ? 'pass' : 'fail',
    detail: `v${process.versions.node} (need >= 18.17 for global fetch)`,
    fix: nodeMajor >= 18 ? undefined : 'Install Node 20 LTS from nodejs.org',
  });

  // 2. RAM
  const recs = recommendModels(totalRamGb);
  checks.push({
    label: 'System RAM',
    state: totalRamGb >= 8 ? (totalRamGb >= 16 ? 'pass' : 'warn') : 'warn',
    detail:
      `${totalRamGb.toFixed(1)} GB total · ${((os.freemem() / 1024 ** 3)).toFixed(1)} GB free now · ` +
      `CPU ${os.cpus().length} cores`,
    fix: `Recommended for this machine: ${recs.map((r) => r.tag).join(' or ')}`,
  });

  // 3. GPU hint
  const gpu = os.cpus()[0]?.model ?? 'unknown CPU';
  const isAppleSilicon = os.platform() === 'darwin' && os.arch() === 'arm64';
  checks.push({
    label: 'Accelerator',
    state: 'warn',
    detail: isAppleSilicon
      ? `Apple Silicon (${gpu}) — Metal acceleration works out of the box`
      : `${gpu} — no GPU detection here; NVIDIA needs CUDA drivers, AMD needs ROCm`,
  });

  // 4. Ollama binary
  const ollamaBin = await runBin(process.platform === 'win32' ? 'ollama.exe' : 'ollama', ['--version']);
  checks.push({
    label: 'Ollama installed',
    state: ollamaBin.ok ? 'pass' : 'fail',
    detail: ollamaBin.ok ? ollamaBin.out.split('\n')[0] ?? 'installed' : `not found (${ollamaBin.out.slice(0, 80)})`,
    fix: ollamaBin.ok
      ? undefined
      : 'Install from https://ollama.com/download (Linux: curl -fsSL https://ollama.com/install.sh | sh)',
  });

  // 5. Ollama server
  const ping = await pingOllama(cfg.ollamaUrl);
  checks.push({
    label: `Ollama server at ${cfg.ollamaUrl}`,
    state: ping.ok ? 'pass' : 'fail',
    detail: ping.ok ? `up · ${(ping.models ?? []).length} model(s) pulled` : ping.error ?? 'unreachable',
    fix: ping.ok ? undefined : 'Start it in another terminal:  ollama serve',
  });

  // 6. Configured model
  const pulled = ping.models ?? [];
  const baseName = cfg.model.split(':')[0] ?? '';
  const modelPresent = pulled.some((m) => m === cfg.model || m.startsWith(`${baseName}:`));
  checks.push({
    label: `Model "${cfg.model}"`,
    state: modelPresent ? 'pass' : ping.ok ? 'fail' : 'warn',
    detail: modelPresent
      ? 'available locally'
      : ping.ok
        ? `not pulled yet. You have: ${pulled.slice(0, 6).join(', ') || '(none)'}`
        : 'cannot check while the server is down',
    fix: modelPresent ? undefined : `ollama pull ${cfg.model}`,
  });

  // 7. Tool-calling capability
  const tier = MODEL_TIERS.find((m) => m.tag.startsWith(baseName));
  if (tier && !tier.nativeTools) {
    checks.push({
      label: 'Native tool calling',
      state: 'warn',
      detail:
        `${cfg.model} does not advertise Ollama "tools" support. LCA will fall back to recovering ` +
        'tool calls from plain text — it works, but expect occasional dropped calls.',
      fix: 'For the best agent experience use a tools-capable model: qwen3:8b, gpt-oss:20b, qwen3-coder:30b',
    });
  } else {
    checks.push({
      label: 'Native tool calling',
      state: 'pass',
      detail: `${cfg.model} supports structured tool calls`,
    });
  }

  // 8. Context window sanity
  checks.push({
    label: 'Context window',
    state: cfg.numCtx >= 8192 ? 'pass' : 'warn',
    detail: `num_ctx=${cfg.numCtx} (Ollama's default is only 2048-4096, which is far too small for an agent)`,
    fix: cfg.numCtx >= 8192 ? undefined : 'Raise it: LCA_NUM_CTX=16384 (costs RAM — roughly 1GB per 8k on a 7B)',
  });

  // 9. Workspace
  checks.push({
    label: 'Workspace',
    state: 'pass',
    detail: `${cfg.workspace} · permission mode "${cfg.permissionMode}"`,
  });

  /* ---------- render ---------- */
  console.log();
  console.log(c.bold(c.magenta('  LCA doctor — local coding agent health check')));
  console.log(c.dim('  ─────────────────────────────────────────────────────────'));
  for (const check of checks) {
    const icon =
      check.state === 'pass' ? c.green('✔') : check.state === 'warn' ? c.yellow('⚠') : c.red('✖');
    console.log(`  ${icon} ${c.bold(check.label)}: ${check.detail}`);
    if (check.fix) console.log(c.dim(`      → ${check.fix}`));
  }

  console.log();
  const fits = MODEL_TIERS.filter((t) => t.minRamGb <= totalRamGb * 0.75);
  const shown = fits.length > 0 ? fits : MODEL_TIERS.slice(0, 2);
  console.log(
    c.bold(
      fits.length > 0
        ? '  Models this machine should be able to run:'
        : '  This machine is below every comfortable tier — smallest options (will be slow):',
    ),
  );
  for (const m of shown) {
    const star = recs.some((r) => r.tag === m.tag) ? c.green('★ ') : '  ';
    console.log(
      `  ${star}${c.cyan(m.tag.padEnd(24))} ${c.dim(
        `~${m.approxDownloadGb}GB · ${m.nativeTools ? 'tools ✓' : 'tools ✗'} · ${m.note}`,
      )}`,
    );
  }
  console.log();

  const failures = checks.filter((ch) => ch.state === 'fail').length;
  if (failures === 0) {
    console.log(`  ${c.green(c.bold('All good.'))} Start it with:  ${c.bold('npm run dev')}  (or ${c.bold('lca')} after npm run build && npm link)`);
  } else {
    console.log(`  ${c.red(c.bold(`${failures} problem(s) to fix`))} — run the "→" commands above, then re-run ${c.bold('lca doctor')}.`);
  }
  console.log();
  return failures === 0 ? 0 : 1;
}
