export interface SkillMeta {
  /** Stable id, e.g. "code", "design". Used to load the skill. */
  name: string;
  /** One line telling the model WHEN to use it. This is what costs context. */
  description: string;
  /** Keywords/regex the deterministic router matches against the user's message. */
  triggers: string[];
  /** Where it came from — bundled, project, or user-global. */
  source: 'bundled' | 'project' | 'user';
  /** Absolute path to SKILL.md */
  path: string;
  /** Directory holding the skill (may contain references/ and scripts/) */
  dir: string;
  /** Extra files shipped with the skill, relative to dir. */
  resources: string[];
  /** Estimated token cost of the FULL body, so we can warn before loading. */
  bodyTokens: number;
}

export interface Skill extends SkillMeta {
  /** The markdown instructions. Loaded eagerly at discovery — kept in memory, not in context. */
  body: string;
}

export interface SkillLoadResult {
  skill: Skill;
  /** Body after the size cap was applied. */
  text: string;
  truncated: boolean;
}

/**
 * The whole point of the skills system: the model sees only names + one-line
 * descriptions (~25 tokens each). The full instructions are loaded on demand.
 *
 * Ten skills cost ~250 tokens permanently instead of ~8,000. On a local model
 * with an 8k window that is the difference between working and not working.
 */
export const INDEX_DESCRIPTION_CHARS = 150;
