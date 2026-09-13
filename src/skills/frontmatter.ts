/**
 * Minimal YAML-frontmatter parser.
 *
 * We support exactly the subset a SKILL.md needs: `key: value` scalars,
 * inline arrays `[a, b]`, and block lists (`- item`). Writing 60 lines beats
 * adding a `yaml` dependency to a project whose rule is zero runtime deps.
 */
export interface Frontmatter {
  data: Record<string, string | string[]>;
  body: string;
}

const FENCE = /^---\s*$/;

export function parseFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  if (!FENCE.test(lines[0] ?? '')) {
    return { data: {}, body: text.trim() };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (FENCE.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  if (end < 0) return { data: {}, body: text.trim() };

  const data: Record<string, string | string[]> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  const flush = (): void => {
    if (currentKey && currentList) data[currentKey] = currentList;
    currentKey = null;
    currentList = null;
  };

  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // block list item
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && currentKey) {
      currentList = currentList ?? [];
      currentList.push(unquote(item[1] ?? ''));
      continue;
    }

    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    flush();

    const key = (kv[1] ?? '').trim();
    const value = (kv[2] ?? '').trim();

    if (value === '') {
      // could be the start of a block list
      currentKey = key;
      currentList = [];
      continue;
    }

    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
      continue;
    }

    data[key] = unquote(value);
  }
  flush();

  return { data, body: lines.slice(end + 1).join('\n').trim() };
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function getString(data: Record<string, string | string[]>, key: string): string {
  const v = data[key];
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.join(', ');
  return '';
}

export function getList(data: Record<string, string | string[]>, key: string): string[] {
  const v = data[key];
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}
