import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

export type LessonSource = 'user' | 'agent' | 'feedback';

export interface Lesson {
  id: string;
  text: string;
  tags: string[];
  createdAt: string;
  source: LessonSource;
  /** +1 each time it helps, -1 each time it is wrong. Low scores get pruned. */
  score: number;
}

export interface Scored {
  lesson: Lesson;
  relevance: number;
}

const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','please','can','you','your','my','me','i','to','of',
  'in','on','for','with','is','are','was','were','be','been','this','that','it','as','at','by',
  'from','how','what','when','where','why','do','does','did','make','get','like','so','we','they',
  'there','here','have','has','had','not','no','yes','all','any','some','one','two','use','using',
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/g, '').trim();
}

/**
 * The agent's long-term memory.
 *
 * This is NOT training — the model's weights never change. It is the thing that
 * actually makes a local agent improve with use: corrections get written down,
 * and the relevant ones are injected into the prompt on later sessions. Cheap,
 * inspectable, editable by hand, and it survives a restart.
 *
 * Stored as append-only JSONL so a crash mid-write can never corrupt the file,
 * and so you can read or grep it without any tooling.
 */
export class LessonStore {
  private lessons: Lesson[] = [];
  private readonly file: string;
  private loaded = false;

  private constructor(file: string) {
    this.file = file;
  }

  static async open(stateDir: string): Promise<LessonStore> {
    const store = new LessonStore(path.join(stateDir, 'memory', 'lessons.jsonl'));
    await store.load();
    return store;
  }

  get path(): string {
    return this.file;
  }

  get count(): number {
    return this.lessons.length;
  }

  all(): Lesson[] {
    return this.lessons.map((l) => ({ ...l }));
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t) as Partial<Lesson>;
        if (!parsed.text) continue;
        this.lessons.push({
          id: String(parsed.id ?? `l_${Math.random().toString(36).slice(2, 10)}`),
          text: String(parsed.text),
          tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
          createdAt: String(parsed.createdAt ?? new Date().toISOString()),
          source: (['user', 'agent', 'feedback'] as string[]).includes(String(parsed.source))
            ? (parsed.source as LessonSource)
            : 'user',
          score: Number(parsed.score ?? 0),
        });
      } catch {
        // A half-written last line is expected after a crash. Skip it.
      }
    }
  }

  /** Save a lesson. Identical text is deduplicated into a score bump instead. */
  async add(text: string, opts: { tags?: string[]; source?: LessonSource } = {}): Promise<Lesson> {
    const clean = text.trim();
    if (!clean) throw new Error('A lesson needs some text.');
    const key = normalise(clean);

    const existing = this.lessons.find((l) => normalise(l.text) === key);
    if (existing) {
      existing.score += 1;
      for (const tag of opts.tags ?? []) {
        if (!existing.tags.includes(tag)) existing.tags.push(tag);
      }
      await this.persist(existing);
      return { ...existing };
    }

    const lesson: Lesson = {
      id: `l_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      text: clean,
      tags: [...new Set((opts.tags ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean))],
      createdAt: new Date().toISOString(),
      source: opts.source ?? 'user',
      score: 1,
    };
    this.lessons.push(lesson);
    await this.persist(lesson);
    return { ...lesson };
  }

  private async persist(lesson: Lesson): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(lesson)}\n`, 'utf8');
  }

  /** Thumbs up/down from the UI. Negative scores sink a lesson out of recall. */
  async vote(id: string, delta: number): Promise<Lesson | null> {
    const lesson = this.lessons.find((l) => l.id === id);
    if (!lesson) return null;
    lesson.score += delta;
    await this.rewrite();
    return { ...lesson };
  }

  async remove(id: string): Promise<boolean> {
    const before = this.lessons.length;
    this.lessons = this.lessons.filter((l) => l.id !== id);
    if (this.lessons.length === before) return false;
    await this.rewrite();
    return true;
  }

  private async rewrite(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(this.file, this.lessons.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  }

  /**
   * Rank lessons against a message by token overlap, weighting tags and
   * file-path-like tokens higher. Deliberately not embeddings: this is free,
   * instant, offline, and good enough for a few hundred lessons.
   */
  relevant(message: string, limit = 5, minScore = 2): Scored[] {
    if (this.lessons.length === 0) return [];
    const msgTokens = new Set(tokens(message));
    if (msgTokens.size === 0) return [];

    const scored: Scored[] = [];
    for (const lesson of this.lessons) {
      if (lesson.score <= -2) continue; // voted down into irrelevance
      let relevance = 0;
      const body = new Set(tokens(lesson.text));
      for (const t of body) if (msgTokens.has(t)) relevance += 1;
      for (const tag of lesson.tags) {
        const tt = tokens(tag);
        for (const t of tt) if (msgTokens.has(t)) relevance += 2;
      }
      // Path-like tokens are strong signals: "src/agent/loop.ts" beats "the".
      for (const t of body) {
        if ((t.includes('/') || t.includes('.')) && msgTokens.has(t)) relevance += 2;
      }
      relevance += Math.min(2, Math.max(0, lesson.score)); // trusted lessons float up
      if (relevance >= minScore) scored.push({ lesson, relevance });
    }

    scored.sort((a, b) => b.relevance - a.relevance || b.lesson.score - a.lesson.score);
    return scored.slice(0, limit);
  }

  /** The block injected into a turn, plus the ids behind it (for 👍/👎 voting). */
  renderBlockWithIds(message: string, limit = 5): { text: string; ids: string[] } {
    const hits = this.relevant(message, limit);
    if (hits.length === 0) return { text: '', ids: [] };
    const lines = hits.map((h) => `- ${h.lesson.text}`);
    return {
      text: [
        '[remembered from earlier sessions]',
        'These were learned while working in this project. Follow them unless the code proves one wrong;',
        'if one IS wrong, say so in one line and use remember to correct it.',
        ...lines,
      ].join('\n'),
      ids: hits.map((h) => h.lesson.id),
    };
  }

  /** The block injected into a turn. Empty string when nothing is relevant. */
  renderBlock(message: string, limit = 5): string {
    return this.renderBlockWithIds(message, limit).text;
  }
}
