// Vault engine: scan a vault through an abstract file system, keep the index up to
// date, and answer "what in the vault relates to this Roam page?". No DOM, no Node
// APIs, so it runs in the Web Worker and in Node tests alike.
import { parseNote, clearInterned } from './core/parser.ts';
import { VaultIndex, toNote } from './core/vault-index.ts';
import { RoamMatcher, type NoteHow } from './core/matcher.ts';
import type { Note } from './core/types.ts';

export interface FileMeta { path: string; size: number; mtime: number }
export interface VaultFS {
  /** Every file in the vault, or in one folder of it and the folders inside: '/'-separated paths
   *  relative to the vault, dot-folders and ignored paths skipped. Rejects with a NotFoundError if
   *  the folder is gone. */
  list(folder?: string): Promise<FileMeta[]>;
  readText(path: string): Promise<string>;
  /** Metadata for one path, or null if it no longer exists. */
  stat(path: string): Promise<FileMeta | null>;
  /**
   * The whole vault, handed over as it is walked, for a full scan to use in place of list() and
   * readText(). `each` gets some of the files and a function that reads the text of the ones named
   * by their position among them (null for one that can't be read); it may be called for a few
   * batches at once, and whatever it throws ends the scan.
   */
  scan?(each: (files: FileMeta[], read: ReadBatch) => Promise<void>): Promise<void>;
}
export type ReadBatch = (want: number[]) => Promise<(string | null)[]>;
/** Notes from an earlier scan, by path. A note is used again while its file's size and time match. */
export type Cache = Map<string, Note>;

export interface Counterpart { path: string; title: string; how: NoteHow; label: string }
export interface BacklinkLine { line: number; text: string; embed: boolean; unresolved: boolean }
export interface Backlink { path: string; title: string; lines: BacklinkLine[] }
export interface Tagged { path: string; title: string; tag: string }
/** A folder named like the page, with the files under it as paths inside the folder. */
export interface FolderMatch { path: string; files: string[]; total: number }
export interface PageResult {
  title: string;
  folders: FolderMatch[];
  counterparts: Counterpart[];
  backlinks: Backlink[];
  tagged: Tagged[];
}
/** `changed`: did the scan leave the index different from how it found it? */
export interface BuildStats { notes: number; files: number; reread: number; cached: number; changed: boolean; errors: string[]; ms: number }

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
const MAX_FOLDERS = 20;
const MAX_FOLDER_FILES = 20_000;
/** Note text kept for the lines shown under a page, in characters (a megabyte or two). */
const MAX_TEXT_CHARS = 1_000_000;
const READS_AT_ONCE = 16;
/** Files handed over at a time by a scan. */
export const SCAN_BATCH = 500;

export class VaultEngine {
  idx = new VaultIndex();
  matcher!: RoamMatcher;
  /** Notes that changed and paths that went away (null) since the cache was last written. */
  unsaved = new Map<string, Note | null>();
  private texts = new Map<string, string>(); // recently read note texts, oldest first, for snippets
  private textChars = 0;

  private fs: VaultFS;
  readonly dailyFormats: string[];
  constructor(fs: VaultFS, dailyFormats: string[] = ['YYYY-MM-DD']) { this.fs = fs; this.dailyFormats = dailyFormats; }

  /** The parsed notes, for the next scan to start from. */
  get cache(): Cache { return this.idx.notes; }

  /** Full scan. Files whose size and mtime match the cache are not re-read. */
  async build(cache: Cache = new Map(), onProgress?: (done: number, total: number) => void): Promise<BuildStats> {
    const t0 = Date.now();
    const errors: string[] = [];
    const unsaved = new Map<string, Note | null>();
    const other: string[] = [];
    const batches: Note[][] = []; // in the order walked, whichever batch is finished first
    let files = 0, reread = 0, done = 0;
    await this.scan(async (batch, read) => {
      const notes: Note[] = [];
      batches.push(notes);
      files += batch.length;
      const want: number[] = [];
      batch.forEach((f, k) => {
        if (!MD.test(f.path)) { other.push(f.path); return; }
        const c = cache.get(f.path);
        if (c && c.size === f.size && c.mtime === f.mtime) { notes.push(c); done++; } else want.push(k);
      });
      const texts = await read(want);
      want.forEach((k, j) => {
        const f = batch[k];
        done++;
        try {
          const note = toNote(parseNote(f.path, readable(texts[j])), f.size, f.mtime);
          notes.push(note);
          unsaved.set(f.path, note);
          reread++;
        } catch (e) { errors.push(`${f.path}: ${(e as Error).name}`); }
      });
      // The number of notes isn't known until the walk is over. A vault scanned before has about
      // as many as last time; for a first scan there is nothing to count towards.
      if (cache.size) onProgress?.(done, Math.max(done, cache.size));
    });
    const ok = batches.flat();
    this.use(ok, other);
    for (const path of cache.keys()) if (!this.idx.notes.has(path)) unsaved.set(path, null);
    this.unsaved = unsaved;
    onProgress?.(done, done);
    return { notes: ok.length, files, reread, cached: ok.length - reread, changed: true, errors, ms: Date.now() - t0 };
  }

  /**
   * Answer from the notes an earlier session left in the cache, before any file has been looked
   * at. check() then brings the index up to date. Attachments aren't in the cache: a link to one
   * counts as unresolved until then.
   */
  adopt(cache: Cache) { this.use([...cache.values()], []); }

  private use(notes: Note[], other: string[]) {
    this.idx = new VaultIndex();
    this.idx.preferNearby = true;
    this.idx.build(notes, other);
    // Only the strong matches are shown, so the weaker lookup tables are not built.
    this.matcher = new RoamMatcher(this.idx, { dailyFormats: this.dailyFormats, sanitized: false });
    this.texts.clear(); this.textChars = 0;
    clearInterned();
  }

  /**
   * Full scan of a vault that already has an index: the index stays in use and only what differs
   * on disk is changed in it, so a scan that finds nothing new costs the walk and nothing else.
   */
  async check(onProgress?: (done: number, total: number) => void): Promise<BuildStats> {
    const t0 = Date.now();
    const errors: string[] = [];
    const seen = new Set<string>();
    const before = this.idx.notes.size;
    let files = 0, reread = 0, done = 0, changed = false;
    await this.scan(async (batch, read) => {
      files += batch.length;
      const want: number[] = [];
      batch.forEach((f, k) => {
        const c = this.idx.notes.get(f.path);
        // The index's own copy of the path where it has one: a million more strings would be 100 MB.
        seen.add(c ? c.path : f.path);
        if (!MD.test(f.path)) { if (!this.idx.files.has(f.path)) { this.idx.addAttachment(f.path); changed = true; } return; }
        if (c && c.size === f.size && c.mtime === f.mtime) done++; else want.push(k);
      });
      const texts = await read(want);
      want.forEach((k, j) => {
        const f = batch[k];
        done++;
        this.forget(f.path);
        try {
          const note = toNote(parseNote(f.path, readable(texts[j])), f.size, f.mtime);
          this.idx.upsertNote(note);
          this.unsaved.set(f.path, note);
          reread++; changed = true;
        } catch (e) {
          errors.push(`${f.path}: ${(e as Error).name}`);
          // As after build(): a note that can't be read is not in the index.
          if (this.idx.notes.has(f.path)) { this.idx.removeFile(f.path); this.unsaved.set(f.path, null); changed = true; }
        }
      });
      onProgress?.(done, Math.max(done, before));
    });
    for (const p of [...this.idx.files.keys()]) {
      if (seen.has(p)) continue;
      this.forget(p);
      this.idx.removeFile(p);
      if (MD.test(p)) this.unsaved.set(p, null);
      changed = true;
    }
    clearInterned();
    onProgress?.(done, done);
    const notes = this.idx.notes.size;
    return { notes, files, reread, cached: notes - reread, changed, errors, ms: Date.now() - t0 };
  }

  private scan(each: (files: FileMeta[], read: ReadBatch) => Promise<void>): Promise<void> {
    return this.fs.scan ? this.fs.scan(each) : scanByList(this.fs, each);
  }

  /** Re-check specific paths after a watcher event. Returns true if anything changed. */
  async refresh(paths: string[]): Promise<boolean> {
    let changed = false;
    for (const path of new Set(paths)) {
      this.forget(path);
      const meta = await this.fs.stat(path).catch(() => null);
      const known = this.idx.files.has(path);
      if (!meta) {
        if (known) { this.idx.removeFile(path); if (MD.test(path)) this.unsaved.set(path, null); changed = true; }
        continue;
      }
      if (!MD.test(path)) { if (!known) { this.idx.addAttachment(path); changed = true; } continue; }
      const c = this.idx.notes.get(path);
      if (c && c.size === meta.size && c.mtime === meta.mtime) continue;
      try {
        const note = toNote(parseNote(path, await this.fs.readText(path)), meta.size, meta.mtime);
        this.idx.upsertNote(note);
        this.unsaved.set(path, note);
        changed = true;
      } catch { /* half-written or placeholder file: the next event will retry */ }
    }
    clearInterned();
    return changed;
  }

  /**
   * Re-check whole folders after a watcher event, walking only them: a folder appeared (its notes
   * may come without events of their own), went away, or moved, or the watcher lost track of what
   * happened inside it. `from` is where a moved folder was: its notes keep their parse under the
   * new path instead of being read again. Returns true if anything changed.
   */
  async refreshFolders(folders: { path: string; from?: string }[], concurrency = 16): Promise<boolean> {
    let changed = false;
    const walk = outermost(folders.map((f) => f.path));
    const clear = new Set<string>();
    const recheck: string[] = [];
    // Notes of a moved folder, by their new path.
    const reuse = new Map<string, Note>();
    for (const { path, from } of folders) {
      if (from === undefined || from === path) continue;
      clear.add(from);
      for (const [p, n] of this.idx.notes) if (p.startsWith(from + '/')) reuse.set(path + p.slice(from.length), n);
    }
    const seen = new Map<string, FileMeta>();
    for (const dir of walk) {
      recheck.push(dir); // a file can have the name the event gave
      try {
        for (const f of await this.fs.list(dir)) seen.set(f.path, f);
        clear.add(dir);
      } catch (e) {
        if ((e as Error)?.name === 'NotFoundError') clear.add(dir);
        else for (const p of this.idx.files.keys()) if (p.startsWith(dir + '/')) recheck.push(p);
      }
    }
    // What the index has in those folders and is no longer there.
    for (const p of [...this.idx.files.keys()]) {
      if (seen.has(p) || !inFolder(p, clear)) continue;
      this.forget(p);
      this.idx.removeFile(p);
      if (MD.test(p)) this.unsaved.set(p, null);
      changed = true;
    }
    const toRead: FileMeta[] = [];
    for (const f of seen.values()) {
      if (!MD.test(f.path)) {
        if (!this.idx.files.has(f.path)) { this.idx.addAttachment(f.path); changed = true; }
        continue;
      }
      const c = this.idx.notes.get(f.path) ?? reuse.get(f.path);
      if (!c || c.size !== f.size || c.mtime !== f.mtime) { toRead.push(f); continue; }
      if (c.path === f.path) continue;
      const note = { ...c, path: f.path };
      this.idx.upsertNote(note);
      this.unsaved.set(f.path, note);
      changed = true;
    }
    let i = 0;
    const work = async () => {
      while (i < toRead.length) {
        const f = toRead[i++];
        this.forget(f.path);
        try {
          const note = toNote(parseNote(f.path, await this.fs.readText(f.path)), f.size, f.mtime);
          this.idx.upsertNote(note);
          this.unsaved.set(f.path, note);
          changed = true;
        } catch { /* half-written or placeholder file: the next event will retry */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, toRead.length) }, work));
    if (await this.refresh(recheck)) changed = true;
    clearInterned();
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
    const srcs = [...bySrc.keys()]
      .sort((x, y) => noteTitle(x).localeCompare(noteTitle(y)) || (x < y ? -1 : x > y ? 1 : 0))
      .slice(0, MAX_BACKLINK_NOTES);
    const backlinks: Backlink[] = srcs.map((src) => ({ path: src, title: noteTitle(src), lines: bySrc.get(src)!.sort((x, y) => x.line - y.line) }));
    for (let i = 0; i < backlinks.length; i += READS_AT_ONCE) {
      await Promise.all(backlinks.slice(i, i + READS_AT_ONCE).map(async (b) => {
        const text = await this.text(b.path);
        if (text !== null) for (const l of b.lines) l.text = snippet(lineAt(text, l.line));
      }));
    }
    const seenTag = new Set<string>();
    const tagged: Tagged[] = [];
    for (const t of a.tagged) if (!seenTag.has(t.path)) { seenTag.add(t.path); tagged.push({ path: t.path, title: noteTitle(t.path), tag: t.tag }); }
    tagged.sort((x, y) => x.title.localeCompare(y.title) || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    return { title, folders: this.folders(title), counterparts, backlinks, tagged };
  }

  /** Folders named like the page, each with the files under it. */
  private folders(title: string): FolderMatch[] {
    // A folder inside one already listed (a copy kept in a subfolder, say) is shown by that one.
    const dirs: string[] = [];
    for (const d of this.idx.foldersNamed(title)) if (!dirs.some((top) => d.startsWith(top + '/'))) dirs.push(d);
    return dirs.slice(0, MAX_FOLDERS).map((dir) => {
      const all = this.idx.filesUnder(dir).map((p) => p.slice(dir.length + 1));
      return { path: dir, total: all.length, files: all.slice(0, MAX_FOLDER_FILES) };
    });
  }

  async read(path: string): Promise<string> { return this.fs.readText(path); }

  /** Resolve a [[link]] target as Obsidian would, from a given source note. */
  resolve(target: string, from: string): string | null {
    return this.idx.candidates(target, from).find((p) => MD.test(p)) ?? null;
  }

  /** A note's text, from the few most recently read ones or from disk. */
  private async text(path: string): Promise<string | null> {
    let t = this.texts.get(path);
    if (t !== undefined) { this.texts.delete(path); this.texts.set(path, t); return t; }
    try { t = await this.fs.readText(path); } catch { return null; }
    if (t.length > MAX_TEXT_CHARS / 4) return t; // too big to be worth a quarter of the budget
    this.forget(path); // another read of the same note may have finished meanwhile
    this.texts.set(path, t); this.textChars += t.length;
    for (const [old, text] of this.texts) {
      if (this.textChars <= MAX_TEXT_CHARS) break;
      this.texts.delete(old); this.textChars -= text.length;
    }
    return t;
  }
  private forget(path: string) {
    const t = this.texts.get(path);
    if (t !== undefined) { this.texts.delete(path); this.textChars -= t.length; }
  }
}

function readable(text: string | null | undefined): string {
  if (text == null) throw new DOMException('unreadable', 'NotReadableError');
  return text;
}

/** scan() for a file system that has none: list everything, then read what is asked for. */
export async function scanByList(fs: VaultFS, each: (files: FileMeta[], read: ReadBatch) => Promise<void>): Promise<void> {
  const all = await fs.list();
  for (let i = 0; i < all.length; i += SCAN_BATCH) {
    const batch = all.slice(i, i + SCAN_BATCH);
    await each(batch, async (want) => {
      const texts: (string | null)[] = [];
      for (let k = 0; k < want.length; k += READS_AT_ONCE) {
        texts.push(...await Promise.all(want.slice(k, k + READS_AT_ONCE).map((w) => fs.readText(batch[w].path).catch(() => null))));
      }
      return texts;
    });
  }
}

/** The folders given, without those inside another one of them. */
export function outermost(folders: string[]): string[] {
  const all = new Set(folders);
  return [...all].filter((f) => !inFolder(f, all));
}
/** Is a path inside one of these folders, at any depth? */
export function inFolder(path: string, folders: Set<string>): boolean {
  for (let i = path.indexOf('/'); i > 0; i = path.indexOf('/', i + 1)) if (folders.has(path.slice(0, i))) return true;
  return false;
}

/** One line of a text, without its line break. */
function lineAt(text: string, line: number): string {
  let s = 0;
  for (let i = 0; i < line; i++) { s = text.indexOf('\n', s) + 1; if (s === 0) return ''; }
  const e = text.indexOf('\n', s);
  return text.slice(s, e < 0 ? text.length : e);
}

function snippet(line: string): string {
  const s = line.replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[.\]\s+)?/, '').replace(/^#+\s+/, '').trim();
  return s.length > MAX_LINE ? s.slice(0, MAX_LINE - 1) + '…' : s;
}
