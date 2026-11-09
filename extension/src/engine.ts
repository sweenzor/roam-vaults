// Vault engine: scan a vault through an abstract file system, keep the index up to
// date, and answer "what in the vault relates to this Roam page?". No DOM, no Node
// APIs, so it runs in the Web Worker and in Node tests alike.
import { parseNote } from './core/parser.ts';
import { VaultIndex } from './core/vault-index.ts';
import { RoamMatcher, type NoteHow } from './core/matcher.ts';
import type { ParsedNote } from './core/types.ts';

export interface FileMeta { path: string; size: number; mtime: number }
export interface VaultFS {
  /** Every file in the vault, '/'-separated paths relative to the root, dot-folders skipped. */
  list(): Promise<FileMeta[]>;
  readText(path: string): Promise<string>;
  /** Metadata for one path, or null if it no longer exists. */
  stat(path: string): Promise<FileMeta | null>;
}
export interface CacheEntry { size: number; mtime: number; note: ParsedNote }
export type Cache = Map<string, CacheEntry>;

export interface Counterpart { path: string; title: string; how: NoteHow; label: string }
export interface BacklinkLine { line: number; text: string; embed: boolean; unresolved: boolean }
export interface Backlink { path: string; title: string; lines: BacklinkLine[] }
export interface Tagged { path: string; title: string; tag: string }
export interface PageResult {
  title: string;
  counterparts: Counterpart[];
  backlinks: Backlink[];
  tagged: Tagged[];
}
export interface BuildStats { notes: number; files: number; reread: number; cached: number; errors: string[]; ms: number }

/** Tiers 1–5 of FEASIBILITY.md §5: the strong matches shown in the MVP. */
const TIER_LABEL: Partial<Record<NoteHow, string>> = {
  exact: 'same name',
  case: 'same name, different case',
  alias: 'alias',
  path: 'folder path',
  daily: 'daily note',
};
const TIER_ORDER: NoteHow[] = ['exact', 'case', 'alias', 'path', 'daily'];

const MD = /\.md$/i;
export const noteTitle = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(MD, '');
const MAX_LINE = 240;
const MAX_BACKLINK_NOTES = 200;

export class VaultEngine {
  idx = new VaultIndex();
  matcher!: RoamMatcher;
  cache: Cache = new Map();
  private lines = new Map<string, string[]>(); // small LRU of split file texts, for snippets

  private fs: VaultFS;
  private dailyFormats: string[];
  constructor(fs: VaultFS, dailyFormats: string[] = ['YYYY-MM-DD']) { this.fs = fs; this.dailyFormats = dailyFormats; }

  /** Full scan. Files whose size and mtime match the cache are not re-read. */
  async build(cache: Cache = new Map(), onProgress?: (done: number, total: number) => void, concurrency = 32): Promise<BuildStats> {
    const t0 = Date.now();
    const all = await this.fs.list();
    const md = all.filter((f) => MD.test(f.path));
    const other = all.filter((f) => !MD.test(f.path)).map((f) => f.path);
    const notes: ParsedNote[] = new Array(md.length);
    const errors: string[] = [];
    const next: Cache = new Map();
    let reread = 0, done = 0, i = 0;
    const work = async () => {
      while (i < md.length) {
        const k = i++, f = md[k];
        const c = cache.get(f.path);
        if (c && c.size === f.size && c.mtime === f.mtime) notes[k] = c.note;
        else {
          try { notes[k] = parseNote(f.path, await this.fs.readText(f.path)); reread++; }
          catch (e) { errors.push(`${f.path}: ${(e as Error).name}`); }
        }
        if (notes[k]) next.set(f.path, { size: f.size, mtime: f.mtime, note: notes[k] });
        if (++done % 50 === 0) onProgress?.(done, md.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, md.length || 1) }, work));
    const ok = notes.filter(Boolean);
    this.idx = new VaultIndex();
    this.idx.preferNearby = true;
    this.idx.build(ok, other);
    this.matcher = new RoamMatcher(this.idx, { dailyFormats: this.dailyFormats });
    this.cache = next;
    this.lines.clear();
    onProgress?.(md.length, md.length);
    return { notes: ok.length, files: all.length, reread, cached: ok.length - reread, errors, ms: Date.now() - t0 };
  }

  /** Re-check specific paths after a watcher event. Returns true if anything changed. */
  async refresh(paths: string[]): Promise<boolean> {
    let changed = false;
    for (const path of new Set(paths)) {
      this.lines.delete(path);
      const meta = await this.fs.stat(path).catch(() => null);
      const known = this.idx.files.has(path);
      if (!meta) {
        if (known) { this.idx.removeFile(path); this.cache.delete(path); changed = true; }
        continue;
      }
      if (!MD.test(path)) { if (!known) { this.idx.addAttachment(path); changed = true; } continue; }
      const c = this.cache.get(path);
      if (known && c && c.size === meta.size && c.mtime === meta.mtime) continue;
      try {
        const note = parseNote(path, await this.fs.readText(path));
        this.idx.upsertNote(note);
        this.cache.set(path, { size: meta.size, mtime: meta.mtime, note });
        changed = true;
      } catch { /* half-written or placeholder file: the next event will retry */ }
    }
    return changed;
  }

  /** Everything the vault knows about one Roam page title. */
  async query(title: string): Promise<PageResult> {
    const a = this.matcher.associations(title);
    const counterparts: Counterpart[] = a.notes
      .filter((n) => TIER_LABEL[n.how])
      .sort((x, y) => TIER_ORDER.indexOf(x.how) - TIER_ORDER.indexOf(y.how) || x.path.localeCompare(y.path))
      .map((n) => ({ path: n.path, title: noteTitle(n.path), how: n.how, label: TIER_LABEL[n.how]! }));
    // Backlinks: only through strong counterparts or unresolved links by text.
    const strong = new Set(counterparts.map((c) => c.path));
    const bySrc = new Map<string, BacklinkLine[]>();
    for (const l of a.links) {
      if (l.via === 'backlink' && (!l.resolvedTo || !strong.has(l.resolvedTo))) continue;
      const arr = bySrc.get(l.src) ?? [];
      if (!bySrc.has(l.src)) bySrc.set(l.src, arr);
      if (arr.some((x) => x.line === l.line)) continue;
      arr.push({ line: l.line, text: '', embed: l.embed, unresolved: l.via !== 'backlink' });
    }
    const srcs = [...bySrc.keys()].sort((x, y) => noteTitle(x).localeCompare(noteTitle(y))).slice(0, MAX_BACKLINK_NOTES);
    const backlinks: Backlink[] = [];
    for (const src of srcs) {
      const lines = bySrc.get(src)!.sort((x, y) => x.line - y.line);
      const text = await this.fileLines(src);
      for (const l of lines) l.text = snippet(text?.[l.line] ?? '');
      backlinks.push({ path: src, title: noteTitle(src), lines });
    }
    const seenTag = new Set<string>();
    const tagged: Tagged[] = [];
    for (const t of a.tagged) if (!seenTag.has(t.path)) { seenTag.add(t.path); tagged.push({ path: t.path, title: noteTitle(t.path), tag: t.tag }); }
    tagged.sort((x, y) => x.title.localeCompare(y.title));
    return { title, counterparts, backlinks, tagged };
  }

  async read(path: string): Promise<string> { return this.fs.readText(path); }

  /** Resolve a [[link]] target as Obsidian would, from a given source note. */
  resolve(target: string, from: string): string | null {
    return this.idx.candidates(target, from).find((p) => MD.test(p)) ?? null;
  }

  private async fileLines(path: string): Promise<string[] | null> {
    let l = this.lines.get(path);
    if (l) { this.lines.delete(path); this.lines.set(path, l); return l; }
    try { l = (await this.fs.readText(path)).split('\n'); } catch { return null; }
    this.lines.set(path, l);
    if (this.lines.size > 300) this.lines.delete(this.lines.keys().next().value!);
    return l;
  }
}

function snippet(line: string): string {
  const s = line.replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[.\]\s+)?/, '').replace(/^#+\s+/, '').trim();
  return s.length > MAX_LINE ? s.slice(0, MAX_LINE - 1) + '…' : s;
}
