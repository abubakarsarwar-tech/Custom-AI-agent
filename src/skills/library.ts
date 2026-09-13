import { discoverSkills, shortDescription } from './loader.js';
import { route, type RouteDecision } from './router.js';
import type { Skill, SkillLoadResult } from './types.js';

export interface LibraryOptions {
  enabled?: boolean;
  extraDirs?: string[];
  /** Hard cap on how much of a skill body enters the context. */
  maxBodyChars?: number;
}

export const DEFAULT_MAX_BODY_CHARS = 12_000;

/**
 * Owns the discovered skills and the progressive-disclosure bookkeeping.
 *
 * Efficiency rules this class enforces:
 *  - only names + one-line descriptions ever go into the system prompt
 *  - a body enters the context once, and we remember that so a second load is
 *    answered with a cheap "already loaded" instead of re-spending the tokens
 *  - bodies are capped, because one 4,000-line skill would eat a whole window
 */
export class SkillLibrary {
  readonly enabled: boolean;
  private skills: Skill[] = [];
  private readonly byName = new Map<string, Skill>();
  private readonly loaded = new Set<string>();
  readonly maxBodyChars: number;
  problems: string[] = [];
  searchedFrom: string[] = [];

  private constructor(enabled: boolean, maxBodyChars: number) {
    this.enabled = enabled;
    this.maxBodyChars = maxBodyChars;
  }

  static async create(workspace: string, opts: LibraryOptions = {}): Promise<SkillLibrary> {
    const enabled = opts.enabled ?? true;
    const lib = new SkillLibrary(enabled, opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS);
    if (!enabled) return lib;

    const found = await discoverSkills(workspace, opts.extraDirs ?? []);
    lib.skills = found.skills;
    lib.problems = found.problems;
    lib.searchedFrom = found.searchedFrom;
    for (const s of found.skills) lib.byName.set(s.name, s);
    return lib;
  }

  get count(): number {
    return this.skills.length;
  }

  /**
   * A copy sharing the discovered skills but with its own loaded-set, and no
   * disk re-scan. A sub-agent must not make the parent believe a skill body is
   * already in *its* context: the loaded-set is per conversation, not per process.
   */
  spawn(): SkillLibrary {
    const lib = new SkillLibrary(this.enabled, this.maxBodyChars);
    lib.skills = this.skills;
    lib.problems = this.problems;
    lib.searchedFrom = this.searchedFrom;
    for (const [name, skill] of this.byName) lib.byName.set(name, skill);
    return lib;
  }

  all(): Skill[] {
    return this.skills;
  }

  get(name: string): Skill | undefined {
    const key = name.trim().toLowerCase();
    return this.byName.get(key) ?? this.byName.get(key.replace(/[\s_]+/g, '-'));
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  loadedNames(): string[] {
    return [...this.loaded];
  }

  /** Drop loaded-state (e.g. after /clear) without re-reading disk. */
  forgetAll(): void {
    this.loaded.clear();
  }

  forget(name: string): void {
    this.loaded.delete(name);
  }

  /**
   * The compact index for the system prompt.
   * ~25 tokens per skill: name, one-line purpose, and size so the model can
   * judge whether loading it is affordable right now.
   */
  renderIndex(): string {
    if (!this.enabled || this.skills.length === 0) return '';
    return this.skills
      .map((s) => `- ${s.name}: ${shortDescription(s)} [~${s.bodyTokens} tok]`)
      .join('\n');
  }

  /** Load a skill body into context, applying the size cap. */
  load(name: string): SkillLoadResult | null {
    const skill = this.get(name);
    if (!skill) return null;
    this.loaded.add(skill.name);

    if (skill.body.length <= this.maxBodyChars) {
      return { skill, text: skill.body, truncated: false };
    }
    const head = skill.body.slice(0, Math.floor(this.maxBodyChars * 0.85));
    const tail = skill.body.slice(skill.body.length - Math.floor(this.maxBodyChars * 0.1));
    return {
      skill,
      text: `${head}\n\n… [skill body truncated: ${
        skill.body.length - head.length - tail.length
      } chars omitted. Use use_skill with resource="<file>" to read a specific part.]\n\n${tail}`,
      truncated: true,
    };
  }

  autoRoute(message: string): RouteDecision {
    if (!this.enabled || this.skills.length === 0) {
      return { pick: null, confidence: 'none', scored: [] };
    }
    return route(message, this.skills);
  }

  /** For `lca skills` and /skills. */
  renderTable(): string {
    if (this.skills.length === 0) return '(no skills found)';
    const width = Math.max(...this.skills.map((s) => s.name.length));
    return this.skills
      .map((s) => {
        const mark = this.loaded.has(s.name) ? '*' : ' ';
        const src = s.source === 'bundled' ? 'built-in' : s.source;
        return `${mark} ${s.name.padEnd(width)}  ${s.bodyTokens.toString().padStart(5)} tok  ${src.padEnd(
          8,
        )}  ${shortDescription(s).slice(0, 90)}`;
      })
      .join('\n');
  }
}
