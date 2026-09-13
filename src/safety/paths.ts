import path from 'node:path';

const SENSITIVE_PATTERNS = [
  /(^|[\\/])\.git[\\/](config|credentials|hooks)([\\/]|$)/i,
  /(^|[\\/])\.ssh[\\/]/i,
  /(^|[\\/])(id_rsa|id_ed25519|\.netrc|\.npmrc|\.aws[\\/]credentials)$/i,
  /(^|[\\/])\.git-credentials$/i,
];

export interface PathCheck {
  ok: boolean;
  abs: string;
  rel: string;
  error?: string;
  sensitive?: boolean;
}

/**
 * Every file tool funnels through here. Two guarantees:
 *  1. the resolved path is inside the workspace (no ../ escape, no absolute /etc/passwd)
 *  2. credential-ish files are flagged so the permission layer can ask twice
 */
export function checkPath(workspace: string, target: string): PathCheck {
  const raw = String(target ?? '').trim();
  if (!raw) {
    return { ok: false, abs: '', rel: '', error: 'Empty path.' };
  }
  const abs = path.resolve(workspace, raw.replace(/^~(?=$|[\\/])/, workspace));
  const root = path.resolve(workspace);
  const inside = abs === root || abs.startsWith(root + path.sep);
  if (!inside) {
    return {
      ok: false,
      abs,
      rel: raw,
      error: `Refusing to touch "${raw}": it resolves to ${abs}, which is outside the workspace ${root}.`,
    };
  }
  const rel = path.relative(root, abs) || '.';
  const sensitive = SENSITIVE_PATTERNS.some((re) => re.test(abs));
  return { ok: true, abs, rel, sensitive };
}

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.turbo',
  '.cache',
]);

export const IGNORED_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.DS_Store',
]);

export function isIgnoredName(name: string): boolean {
  return IGNORED_DIRS.has(name) || IGNORED_FILES.has(name);
}

export function truncate(text: string, max: number, label = 'output'): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(text.length - Math.floor(max * 0.2));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n... [${label} truncated: ${omitted.toLocaleString()} chars omitted] ...\n\n${tail}`;
}

export function looksBinary(buf: Uint8Array): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.3;
}
