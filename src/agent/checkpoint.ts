import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface CheckpointFile {
  /** Workspace-relative path, exactly as the tool saw it. */
  rel: string;
  /** false = the file did not exist before this turn, so restoring deletes it. */
  existed: boolean;
  bytes: number;
}

export interface Checkpoint {
  id: string;
  /** The user message that started the turn — how you recognise it later. */
  label: string;
  createdAt: string;
  files: CheckpointFile[];
  /** Set once this checkpoint has been rolled back to. */
  restoredAt?: string;
}

export interface RestoreResult {
  id: string;
  /** Files whose previous content was put back. */
  reverted: string[];
  /** Files the agent had created, now removed. */
  deleted: string[];
}

const ID_PREFIX = 'cp_';

function sanitizeLabel(label: string): string {
  const one = label.replace(/\s+/g, ' ').trim();
  return one.length > 120 ? `${one.slice(0, 117)}…` : one;
}

/**
 * Rollback for the agent's own edits.
 *
 * Before a mutating tool touches a file, it calls `capture()`, which stores the
 * original bytes under `.agent/checkpoints/<id>/files/<rel>`. The first capture
 * of a file in a turn wins, so restoring returns the workspace to exactly how it
 * looked *before that turn* — not to some intermediate state.
 *
 * Layout on disk (one manifest per checkpoint, no shared index to drift):
 *
 *   .agent/checkpoints/
 *     cp_lz1a2b3c_d4e5/
 *       manifest.json
 *       files/src/index.ts        <- the bytes that were there before
 *
 * Deliberately plain files: you can inspect a checkpoint, copy something out of
 * it by hand, or delete the whole folder with `rm -rf` and lose nothing else.
 *
 * Scope, stated honestly: this covers `write_file` and `edit_file`. A `bash`
 * command can change files in ways nobody can track from here — that is what
 * version control is for, and the agent says so when it runs one.
 */
export class CheckpointStore {
  private readonly dir: string;
  private readonly keep: number;
  private checkpoints: Checkpoint[] = [];
  private current: Checkpoint | null = null;
  private capturedThisTurn = new Set<string>();
  private loaded = false;

  private constructor(dir: string, keep: number) {
    this.dir = dir;
    this.keep = keep;
  }

  static async open(stateDir: string, opts: { keep?: number } = {}): Promise<CheckpointStore> {
    const store = new CheckpointStore(path.join(stateDir, 'checkpoints'), opts.keep ?? 20);
    await store.load();
    return store;
  }

  get root(): string {
    return this.dir;
  }

  get count(): number {
    return this.checkpoints.length;
  }

  /* ---------------- reading ---------------- */

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.dir)) return;

    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }

    const found: Checkpoint[] = [];
    for (const entry of entries) {
      if (!entry.startsWith(ID_PREFIX)) continue;
      const manifest = path.join(this.dir, entry, 'manifest.json');
      try {
        const parsed = JSON.parse(await readFile(manifest, 'utf8')) as Partial<Checkpoint>;
        if (!parsed.id || !Array.isArray(parsed.files)) continue;
        found.push({
          id: String(parsed.id),
          label: String(parsed.label ?? ''),
          createdAt: String(parsed.createdAt ?? new Date(0).toISOString()),
          files: parsed.files.map((f) => ({
            rel: String(f.rel),
            existed: f.existed !== false,
            bytes: Number(f.bytes ?? 0),
          })),
          ...(parsed.restoredAt ? { restoredAt: String(parsed.restoredAt) } : {}),
        });
      } catch {
        // A half-written manifest means a crash mid-turn. Skip it; the folder
        // is still readable by hand and pruning will eventually clear it.
      }
    }

    found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.checkpoints = found;
  }

  /** Newest first — that is the order both UIs want. */
  list(): Checkpoint[] {
    return this.checkpoints.slice().reverse().map((c) => ({ ...c, files: c.files.map((f) => ({ ...f })) }));
  }

  get(id: string): Checkpoint | null {
    const hit = this.checkpoints.find((c) => c.id === id);
    return hit ? { ...hit, files: hit.files.map((f) => ({ ...f })) } : null;
  }

  /* ---------------- capturing ---------------- */

  /** Start collecting for a new turn. Cheap and synchronous; nothing is written yet. */
  begin(label: string): Checkpoint {
    const id = `${ID_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.current = {
      id,
      label: sanitizeLabel(label),
      createdAt: new Date().toISOString(),
      files: [],
    };
    this.capturedThisTurn = new Set();
    return { ...this.current };
  }

  /**
   * Save the current bytes of one file so the turn can be rolled back.
   * Returns false when there was nothing to save (no turn open, already
   * captured, or the file does not exist and never did).
   *
   * `preloaded` lets a tool that has already read the file hand the content
   * over instead of paying for a second read.
   */
  async capture(rel: string, abs: string, preloaded?: string | null): Promise<boolean> {
    if (!this.current) return false;
    const key = path.normalize(rel);
    if (this.capturedThisTurn.has(key)) return false;

    let existed: boolean;
    let data: Buffer;
    if (preloaded !== undefined) {
      existed = preloaded !== null;
      data = Buffer.from(preloaded ?? '', 'utf8');
    } else {
      try {
        data = await readFile(abs);
        existed = true;
      } catch {
        existed = false;
        data = Buffer.alloc(0);
      }
    }

    // First capture wins: that is what makes a restore land on the pre-turn state.
    this.capturedThisTurn.add(key);

    const target = this.safeFileSlot(key);
    if (!target) return false;

    if (existed) {
      await mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, target); // atomic: a crash cannot leave a half-written backup
    }

    this.current.files.push({ rel: key, existed, bytes: data.length });
    return true;
  }

  /** Persist the turn's checkpoint. Returns null when the turn changed nothing. */
  async finish(): Promise<Checkpoint | null> {
    const cp = this.current;
    this.current = null;
    this.capturedThisTurn.clear();
    if (!cp || cp.files.length === 0) return null;

    const folder = path.join(this.dir, cp.id);
    await mkdir(folder, { recursive: true });
    const manifest = path.join(folder, 'manifest.json');
    const tmp = `${manifest}.tmp`;
    await writeFile(tmp, `${JSON.stringify(cp, null, 2)}\n`, 'utf8');
    await rename(tmp, manifest);

    this.checkpoints.push(cp);
    await this.prune();
    return { ...cp, files: cp.files.map((f) => ({ ...f })) };
  }

  /** Drop a turn that failed or was interrupted before writing anything. */
  discard(): void {
    this.current = null;
    this.capturedThisTurn.clear();
  }

  /* ---------------- restoring ---------------- */

  /**
   * Put the workspace back the way it was before that turn.
   *
   * The state you are leaving is itself checkpointed first, so a restore can be
   * undone — rolling back is never the irreversible move.
   */
  async restore(id: string, workspace: string): Promise<RestoreResult | null> {
    const cp = this.get(id);
    if (!cp) return null;

    const undoId = `${ID_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const undoFolder = path.join(this.dir, undoId);
    const reverted: string[] = [];
    const deleted: string[] = [];
    const undoFiles: CheckpointFile[] = [];

    for (const f of cp.files) {
      const abs = path.resolve(workspace, f.rel);
      // Belt and braces: the manifest is ours, but it lives on disk where
      // anything could have edited it.
      if (!this.inside(workspace, abs)) continue;

      // Snapshot what is there NOW, so this restore can itself be rolled back.
      let nowBytes: Buffer | null = null;
      try {
        nowBytes = await readFile(abs);
      } catch {
        nowBytes = null;
      }
      if (nowBytes !== null) {
        const slot = path.join(undoFolder, 'files', f.rel);
        if (this.inside(undoFolder, slot)) {
          await mkdir(path.dirname(slot), { recursive: true });
          await writeFile(slot, nowBytes);
        }
      }
      undoFiles.push({ rel: f.rel, existed: nowBytes !== null, bytes: nowBytes?.length ?? 0 });

      if (f.existed) {
        const backup = path.join(this.dir, cp.id, 'files', f.rel);
        if (!this.inside(path.join(this.dir, cp.id), backup)) continue;
        try {
          const original = await readFile(backup);
          await mkdir(path.dirname(abs), { recursive: true });
          await writeFile(abs, original);
          reverted.push(f.rel);
        } catch {
          // Backup missing (folder pruned or hand-deleted): leave the file alone
          // rather than guessing at its contents.
        }
      } else {
        try {
          await rm(abs, { force: true });
          deleted.push(f.rel);
        } catch {
          /* already gone */
        }
      }
    }

    if (undoFiles.length > 0) {
      const undoCp: Checkpoint = {
        id: undoId,
        label: `state before restoring ${cp.id}`,
        createdAt: new Date().toISOString(),
        files: undoFiles,
      };
      await mkdir(undoFolder, { recursive: true });
      await writeFile(
        path.join(undoFolder, 'manifest.json'),
        `${JSON.stringify(undoCp, null, 2)}\n`,
        'utf8',
      );
      this.checkpoints.push(undoCp);
    }

    cp.restoredAt = new Date().toISOString();
    const stored = this.checkpoints.find((c) => c.id === id);
    if (stored) stored.restoredAt = cp.restoredAt;
    await this.writeManifest(cp);
    await this.prune();

    return { id: cp.id, reverted, deleted };
  }

  /* ---------------- housekeeping ---------------- */

  private async writeManifest(cp: Checkpoint): Promise<void> {
    const manifest = path.join(this.dir, cp.id, 'manifest.json');
    if (!existsSync(path.dirname(manifest))) return;
    const tmp = `${manifest}.tmp`;
    await writeFile(tmp, `${JSON.stringify(cp, null, 2)}\n`, 'utf8');
    await rename(tmp, manifest);
  }

  /** Keep the newest `keep` checkpoints and delete the rest, folders included. */
  private async prune(): Promise<void> {
    if (this.checkpoints.length <= this.keep) return;
    const drop = this.checkpoints.splice(0, this.checkpoints.length - this.keep);
    for (const cp of drop) {
      await rm(path.join(this.dir, cp.id), { recursive: true, force: true });
    }
  }

  async clear(): Promise<number> {
    const n = this.checkpoints.length;
    this.checkpoints = [];
    this.discard();
    await rm(this.dir, { recursive: true, force: true });
    return n;
  }

  /** Total bytes held by every checkpoint, for the stats line and `/checkpoints`. */
  async sizeBytes(): Promise<number> {
    let total = 0;
    for (const cp of this.checkpoints) {
      for (const f of cp.files) total += f.bytes;
    }
    // manifest overhead is small but real; measure the folder if it exists
    try {
      const s = await stat(this.dir);
      if (s.isDirectory()) total += this.checkpoints.length * 512;
    } catch {
      /* nothing on disk yet */
    }
    return total;
  }

  /* ---------------- path safety ---------------- */

  private inside(root: string, target: string): boolean {
    const r = path.resolve(root);
    const t = path.resolve(target);
    return t === r || t.startsWith(r + path.sep);
  }

  /** Where a file's backup lives, or null if the path tries to escape. */
  private safeFileSlot(rel: string): string | null {
    if (!this.current) return null;
    const base = path.join(this.dir, this.current.id, 'files');
    const slot = path.resolve(base, rel);
    return this.inside(base, slot) ? slot : null;
  }
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
