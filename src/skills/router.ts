import type { Skill } from './types.js';

export interface RouteMatch {
  skill: Skill;
  score: number;
  matched: string[];
}

export interface RouteDecision {
  /** The skill to auto-load, if we are confident. */
  pick: Skill | null;
  /** Why — shown to the user in verbose mode and useful when tuning triggers. */
  confidence: 'none' | 'weak' | 'strong';
  scored: RouteMatch[];
}

/**
 * Score at or above which we auto-load without asking the model to choose.
 * 5 = one multi-word trigger, or one word plus corroborating keywords.
 * A single generic word ("merge", "test", "add") scores 4 and is NOT enough on
 * its own — that is what stops ambiguous requests from being mis-routed.
 */
const STRONG = 5;
/** Minimum lead over the runner-up, so an ambiguous request is left to the model. */
const MIN_LEAD = 2;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'please', 'can', 'you', 'your', 'my', 'me',
  'i', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'be', 'this', 'that', 'it',
  'as', 'at', 'by', 'from', 'how', 'what', 'do', 'does', 'make', 'get', 'like', 'so', 'we',
]);

/** Words that carry meaning about intent, extracted from a skill's own metadata. */
function deriveKeywords(skill: Skill): string[] {
  const words = `${skill.name} ${skill.description}`
    .toLowerCase()
    .replace(/[^a-z0-9\s_+-]/g, ' ')
    .split(/[\s_]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cheap deterministic routing.
 *
 * A 7B model asked "which of these ten skills should I use?" wastes a whole
 * round-trip and often picks badly. For the common cases we can decide with a
 * keyword score in microseconds, auto-load the skill, and tell the model it is
 * already loaded. Ambiguous requests fall through to the model's own choice.
 */
export function route(message: string, skills: Skill[]): RouteDecision {
  const text = ` ${message.toLowerCase().replace(/\s+/g, ' ')} `;
  const scored: RouteMatch[] = [];

  for (const skill of skills) {
    let score = 0;
    const matched: string[] = [];

    // Declared triggers are authoritative and weighted heavily.
    for (const trigger of skill.triggers) {
      const t = trigger.trim();
      if (!t) continue;
      const isRegex = t.startsWith('/') && t.lastIndexOf('/') > 0;
      // A two-word trigger ("test suite") is much stronger evidence than a
      // one-word one ("test"), because it cannot be an incidental mention.
      const weight = 3 + Math.max(1, t.trim().split(/\s+/).length);
      try {
        if (isRegex) {
          const end = t.lastIndexOf('/');
          const re = new RegExp(t.slice(1, end), t.slice(end + 1) || 'i');
          if (re.test(message)) {
            score += weight + 1;
            matched.push(t);
          }
        } else if (text.includes(` ${t.toLowerCase()} `) || text.includes(t.toLowerCase())) {
          score += weight;
          matched.push(t);
        }
      } catch {
        if (text.includes(t.toLowerCase())) {
          score += weight;
          matched.push(t);
        }
      }
    }

    // Derived keywords are weaker evidence, and saturate so a long description
    // cannot outvote an explicit trigger.
    const keywords = deriveKeywords(skill);
    let kwHits = 0;
    for (const kw of keywords) {
      if (kw.length <= 3) {
        if (text.includes(` ${kw} `)) kwHits += 1;
      } else if (text.includes(kw)) {
        kwHits += 1;
      }
    }
    if (kwHits > 0) {
      score += Math.min(3, kwHits);
      if (matched.length === 0) matched.push(`${kwHits} keyword(s)`);
    }

    // An explicit request for this skill. Deliberately NOT a bare name match:
    // skill names are common English words ("test", "docs", "review"), so
    // matching them alone hijacks sentences like "the test suite is failing",
    // which is debugging, not test-writing.
    // Note: "the" is deliberately NOT a cue word. "the test keeps crashing" is
    // a debugging request, not a request for the test skill.
    const asked = new RegExp(
      `(?:\\b(?:use|load|apply|activate|switch to|enable)\\s+(?:the\\s+)?${escapeRe(
        skill.name,
      )}\\b)|(?:\\b${escapeRe(skill.name)}\\s+skill\\b)`,
    ).test(text);
    if (asked) {
      score += 6;
      matched.push(`explicitly asked for "${skill.name}"`);
    }

    if (score > 0) scored.push({ skill, score, matched });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const second = scored[1];

  if (!top) return { pick: null, confidence: 'none', scored };

  const lead = second ? top.score - second.score : top.score;
  if (top.score >= STRONG && lead >= MIN_LEAD) {
    return { pick: top.skill, confidence: 'strong', scored };
  }
  if (top.score >= STRONG) {
    return { pick: null, confidence: 'weak', scored };
  }
  return { pick: null, confidence: 'weak', scored };
}
