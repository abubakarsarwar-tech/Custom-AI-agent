import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getList, getString, parseFrontmatter } from './frontmatter.js';
import { INDEX_DESCRIPTION_CHARS, type Skill, type SkillMeta } from './types.js';
import { estimateTokens } from '../agent/tokens.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Skills that ship with the package. Works from both src/ (tsx) and dist/. */
export const BUNDLED_SKILLS_DIR = path.resolve(here, '..', '..', 'skills');

export function userSkillsDir(): string {
  return path.join(os.homedir(), '.config', 'local-code-agent', 'skills');
}

export function projectSkillsDirs(workspace: string): string[] {
  return [path.join(workspace, '.agent', 'skills'), path.join(workspace, 'skills')];
}

/** Lowest priority first; later entries override earlier ones by name. */
export function skillSearchPath(workspace: string, extra: string[] = []): Array<{ dir: string; source: SkillMeta['source'] }> {
  return [
    { dir: BUNDLED_SKILLS_DIR, source: 'bundled' },
    { dir: userSkillsDir(), source: 'user' },
    ...projectSkillsDirs(workspace).map((dir) => ({ dir, source: 'project' as const })),
    ...extra.map((dir) => ({ dir, source: 'project' as const })),
  ];
}

function deriveDescription(body: string, fallback: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue; // skip headings
    if (t.startsWith('```')) break;
    if (t.startsWith('-') || t.startsWith('>')) continue;
    return t.replace(/\s+/g, ' ').slice(0, 300);
  }
  return fallback;
}

async function listResources(dir: string, limit = 25): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    if (out.length >= limit) return;
    const abs = path.join(dir, rel);
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        await walk(childRel);
      } else if (e.name !== 'SKILL.md') {
        out.push(childRel);
      }
    }
  }
  await walk('');
  return out;
}

async function loadOne(mdPath: string, dir: string, source: SkillMeta['source']): Promise<Skill | null> {
  let raw: string;
  try {
    raw = await readFile(mdPath, 'utf8');
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(raw);
  if (!body.trim()) return null;

  const dirName = path.basename(dir);
  const fileName = path.basename(mdPath, '.md');
  const name = (getString(data, 'name') || (mdPath.endsWith('SKILL.md') ? dirName : fileName))
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!name) return null;

  const description = getString(data, 'description') || deriveDescription(body, name);

  return {
    name,
    description: description.slice(0, 400),
    triggers: getList(data, 'triggers'),
    source,
    path: mdPath,
    dir,
    resources: await listResources(dir),
    bodyTokens: estimateTokens(body),
    body,
  };
}

export interface DiscoverResult {
  skills: Skill[];
  /** Dirs that were searched but missing/empty — surfaced by `lca skills` for debugging. */
  searchedFrom: string[];
  problems: string[];
}

/**
 * Discover every SKILL.md across the search path. Later sources win, so a
 * project can override a bundled skill just by shipping its own `skills/code/`.
 */
export async function discoverSkills(workspace: string, extraDirs: string[] = []): Promise<DiscoverResult> {
  const byName = new Map<string, Skill>();
  const searchedFrom: string[] = [];
  const problems: string[] = [];
  // The bundled dir and <workspace>/skills are the SAME folder when you run the
  // agent inside this repo. Without this every skill would be loaded twice and
  // report a bogus "project overrides bundled" note.
  const seenDirs = new Set<string>();

  for (const { dir, source } of skillSearchPath(workspace, extraDirs)) {
    const resolved = path.resolve(dir);
    if (seenDirs.has(resolved)) continue;
    seenDirs.add(resolved);

    searchedFrom.push(`${dir} (${source})`);
    if (!existsSync(dir)) continue;
    let st;
    try {
      st = await stat(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      problems.push(`cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        const md = path.join(dir, entry.name, 'SKILL.md');
        if (!existsSync(md)) {
          problems.push(`${path.join(dir, entry.name)} has no SKILL.md — skipped`);
          continue;
        }
        const skill = await loadOne(md, path.join(dir, entry.name), source);
        if (!skill) {
          problems.push(`${md} is empty or unreadable — skipped`);
          continue;
        }
        const prev = byName.get(skill.name);
        if (prev && path.resolve(prev.dir) !== path.resolve(skill.dir)) {
          problems.push(`skill "${skill.name}" from ${source} (${skill.dir}) overrides the ${prev.source} one`);
        }
        byName.set(skill.name, skill);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const skill = await loadOne(path.join(dir, entry.name), dir, source);
        if (skill) byName.set(skill.name, skill);
      }
    }
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, searchedFrom, problems };
}

export function shortDescription(skill: Skill): string {
  const d = skill.description.replace(/\s+/g, ' ').trim();
  return d.length > INDEX_DESCRIPTION_CHARS ? `${d.slice(0, INDEX_DESCRIPTION_CHARS - 1)}…` : d;
}
