/** Minimal line-diff so the UI can show the model what it just changed. */

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  text: string;
}

const MAX_DIFF_CELLS = 4_000_000; // guard against O(n*m) blowups on big files

export function diffLines(before: string, after: string, context = 3): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [
      ...a.map((text) => ({ type: 'del' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text })),
    ];
  }

  // Longest common subsequence table. `at()` keeps noUncheckedIndexedAccess happy.
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = new Int32Array(rows * cols);
  const at = (r: number, cc: number): number => dp[r * cols + cc] ?? 0;

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * cols + j] =
        a[i] === b[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const raw: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const la = a[i] ?? '';
    const lb = b[j] ?? '';
    if (la === lb) {
      raw.push({ type: 'ctx', text: la });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      raw.push({ type: 'del', text: la });
      i += 1;
    } else {
      raw.push({ type: 'add', text: lb });
      j += 1;
    }
  }
  while (i < a.length) raw.push({ type: 'del', text: a[i++] ?? '' });
  while (j < b.length) raw.push({ type: 'add', text: b[j++] ?? '' });

  // Collapse unchanged runs longer than 2*context+1 into a gap marker.
  const keep = new Array<boolean>(raw.length).fill(false);
  for (let k = 0; k < raw.length; k += 1) {
    if (raw[k]?.type !== 'ctx') {
      for (let m = Math.max(0, k - context); m <= Math.min(raw.length - 1, k + context); m += 1) {
        keep[m] = true;
      }
    }
  }
  const out: DiffLine[] = [];
  let skipped = 0;
  for (let k = 0; k < raw.length; k += 1) {
    const line = raw[k];
    if (!line) continue;
    if (keep[k]) {
      if (skipped > 0) {
        out.push({ type: 'ctx', text: `⋯ ${skipped} unchanged lines` });
        skipped = 0;
      }
      out.push(line);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) out.push({ type: 'ctx', text: `⋯ ${skipped} unchanged lines` });
  return out;
}

export function renderDiff(lines: DiffLine[]): string {
  return lines
    .map((l) => (l.type === 'add' ? `+ ${l.text}` : l.type === 'del' ? `- ${l.text}` : `  ${l.text}`))
    .join('\n');
}
