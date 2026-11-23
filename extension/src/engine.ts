// Vault engine: scan a vault through an abstract file system, keep the index up to
// date, and answer "what in the vault relates to this Roam page?". No DOM, no Node
// APIs, so it runs in the Web Worker and in Node tests alike.
import { parseNote, clearInterned } from './core/parser.ts';
import { VaultIndex, toNote, type Stamp } from './core/vault-index.ts';
import { RoamMatcher, type NoteHow } from './core/matcher.ts';
import { FuzzyIndex, NAME } from './core/fuzzy-index.ts';
import { diffMarks } from './core/fuzzy.ts';
import type { Note } from './core/types.ts';
import { contextOf, putLine, type ReadLine, type LineRead } from './core/outline.ts';

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
/** A line of a note that links to the page. Once read, it comes as the block the line is in: its
 *  text, the blocks above it (`up`, outermost first) and the blocks under it (`kids`). */
export interface BacklinkLine extends ReadLine { line: number; embed: boolean; unresolved: boolean }

export interface Backlink {
  path: string; title: string; lines: BacklinkLine[];
  /** The note has not been read for the text of its lines yet: lines() reads it. */
  unread?: true;
}
export interface Tagged { path: string; title: string; tag: string }
/** A note inside a folder named like the page. */
/** `from`: where in `path` the folder named like the page starts (0 at the top of the vault). */
export interface FolderNote { path: string; title: string; from: number }
export interface PageResult {
  title: string;
  counterparts: Counterpart[];
  backlinks: Backlink[];
  tagged: Tagged[];
  /** Notes inside folders named like the page, at any depth, that are not listed above. */
  inFolders: FolderNote[];
  /** Notes whose name or alias is close to the title (typos, word order), when no note is this
   *  page. Shown last, set apart from the rest. */
  fuzzy: FuzzyNote[];
  /** The folders that are an OKF bundle's root ('' the vault's own). */
  bundles: string[];
}
export interface FuzzyNote {
  path: string; title: string; score: number; sim: number;
  /** Where the note's name differs from the page title: [start, end) in `title`, flat pairs.
   *  Empty when the match was an alias. */
  marks: number[];
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
const MAX_BACKLINK_NOTES = 200;
/** Close-named notes shown under a page with no matching note. */
const MAX_FUZZY = 5;
const MAX_FOLDER_NOTES = 20_000;
/** Note text kept for the lines shown under a page, in characters (a megabyte or two). */
const MAX_TEXT_CHARS = 1_000_000;
const READS_AT_ONCE = 16;
/** Linking notes whose lines a page asks for with its result: as many as it draws at first. Most of
 *  what a page costs is reading those notes, so the rest are read when they are scrolled to. */
export const LINES_AT_FIRST = 60;
/** Files handed over at a time by a scan. */
export const SCAN_BATCH = 500;

export class VaultEngine {
  idx = new VaultIndex();
  matcher!: RoamMatcher;
  fuzzyIdx: FuzzyIndex | undefined;
  /** Notes that changed and paths that went away (null) since the cache was last written. */
  unsaved = new Map<string, Note | null>();
  private texts = new Map<string, string>(); // recently read note texts, oldest first, for snippets
  private textChars = 0;

  private fs: VaultFS;
  readonly dailyFormats: string[];
  /** An index kept across starts (a database), or none: the index is built in memory and its
   *  notes are saved by whoever owns the engine (see `unsaved`). */
  private store: VaultIndex | null;
  constructor(fs: VaultFS, dailyFormats: string[] = ['YYYY-MM-DD'], store: VaultIndex | null = null) {
    this.fs = fs; this.dailyFormats = dailyFormats; this.store = store;
    if (!store) return;
    // What the store holds is in use from here on: it is its own cache, and check() is its scan.
    this.idx = store; store.preferNearby = true;
    this.matcher = new RoamMatcher(store, { dailyFormats, sanitized: false });
    store.flush();
  }

  /** The parsed notes, for the next scan to start from. */
  get cache(): Cache { return this.idx.notes; }

  /** Full scan. Files whose size and mtime match the cache are not re-read. */
  async build(cache: Cache = new Map(), onProgress?: (done: number, total: number) => void): Promise<BuildStats> {
    if (this.store) return this.check(onProgress);
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
    this.fuzzyIdx = undefined; // made on first use, for this index (a database has its own)
    this.texts.clear(); this.textChars = 0;
    clearInterned();
  }

  /**
   * Full scan into the index in use: only what differs on disk is changed in it, so a scan that
   * finds nothing new costs the walk and little else. Queries meanwhile see a mix of old and new
   * notes, each one whole. For an index kept across starts this is every scan, the first included.
   */
  async check(onProgress?: (done: number, total: number) => void): Promise<BuildStats> {
    const t0 = Date.now();
    const idx = this.idx;
    const errors: string[] = [];
    const before = idx.noteCount();
    // Everything the index has: what the walk comes across is taken out, and the rest is gone. A
    // database lists it a piece at a time, and answers the pages waiting for this vault in between.
    const listed: Promise<Map<string, Stamp | null>> = Promise.resolve(idx.stamps());
    listed.catch(() => {}); // a failure is the scan's to report, when it asks
    let files = 0, reread = 0, done = 0, changed = false;
    const empty = idx.isEmpty();
    try {
      if (empty) idx.bulk(true);
      await this.scan(async (batch, read) => {
        files += batch.length;
        const want: number[] = [];
        const had = await listed;
        batch.forEach((f, k) => {
          const c = had.get(f.path);
          had.delete(f.path);
          if (!MD.test(f.path)) { if (c === undefined) { idx.addAttachment(f.path); changed = true; } return; }
          if (c && c.size === f.size && c.mtime === f.mtime) done++; else want.push(k);
        });
        const texts = await read(want);
        const notes: Note[] = [];
        want.forEach((k, j) => {
          const f = batch[k];
          done++;
          this.forget(f.path);
          try { notes.push(toNote(parseNote(f.path, readable(texts[j])), f.size, f.mtime)); }
          catch (e) {
            errors.push(`${f.path}: ${(e as Error).name}`);
            // As after build(): a note that can't be read is not in the index.
            if (idx.hasFile(f.path)) { idx.removeFile(f.path); this.save(f.path, null); changed = true; }
          }
        });
        if (notes.length) {
          idx.upsertNotes(notes); // the batch at once: a database call costs much more than a row
          for (const n of notes) this.save(n.path, n);
          reread += notes.length; changed = true;
        }
        // An index with nothing in it yet has no number of notes to count towards.
        if (before) onProgress?.(done, Math.max(done, before));
      });
      for (const p of (await listed).keys()) {
        this.forget(p);
        idx.removeFile(p);
        if (MD.test(p)) this.save(p, null);
        changed = true;
      }
    } finally {
      idx.flush(); // a scan that stops part way keeps what it wrote
      if (empty) idx.bulk(false);
    }
    clearInterned();
    onProgress?.(done, done);
    const notes = idx.noteCount();
    return { notes, files, reread, cached: notes - reread, changed, errors, ms: Date.now() - t0 };
  }

  /** Note a change for the saved cache. An index kept across starts has saved it already. */
  private save(path: string, note: Note | null) { if (!this.store) this.unsaved.set(path, note); }

  private scan(each: (files: FileMeta[], read: ReadBatch) => Promise<void>): Promise<void> {
    return this.fs.scan ? this.fs.scan(each) : scanByList(this.fs, each);
  }

  /** Re-check specific paths after a watcher event. Returns true if anything changed. */
  async refresh(paths: string[]): Promise<boolean> {
    try { return await this.refreshPaths(paths); } finally { this.idx.flush(); }
  }
  private async refreshPaths(paths: string[]): Promise<boolean> {
    let changed = false;
    for (const path of new Set(paths)) {
      this.forget(path);
      const meta = await this.fs.stat(path).catch(() => null);
      const known = this.idx.hasFile(path);
      if (!meta) {
        if (known) { this.idx.removeFile(path); if (MD.test(path)) this.save(path, null); changed = true; }
        continue;
      }
      if (!MD.test(path)) { if (!known) { this.idx.addAttachment(path); changed = true; } continue; }
      const c = this.idx.stampOf(path);
      if (c && c.size === meta.size && c.mtime === meta.mtime) continue;
      try {
        const note = toNote(parseNote(path, await this.fs.readText(path)), meta.size, meta.mtime);
        this.idx.upsertNote(note);
        this.save(path, note);
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
    try { return await this.refreshFoldersNow(folders, concurrency); } finally { this.idx.flush(); }
  }
  private async refreshFoldersNow(folders: { path: string; from?: string }[], concurrency: number): Promise<boolean> {
    let changed = false;
    const walk = outermost(folders.map((f) => f.path));
    const clear = new Set<string>();
    const recheck: string[] = [];
    // Notes of a moved folder, by their new path.
    const reuse = new Map<string, Note>();
    for (const { path, from } of folders) {
      if (from === undefined || from === path) continue;
      clear.add(from);
      for (const n of this.idx.notesIn(from)) reuse.set(path + n.path.slice(from.length), n);
    }
    const seen = new Map<string, FileMeta>();
    for (const dir of walk) {
      recheck.push(dir); // a file can have the name the event gave
      try {
        for (const f of await this.fs.list(dir)) seen.set(f.path, f);
        clear.add(dir);
      } catch (e) {
        if ((e as Error)?.name === 'NotFoundError') clear.add(dir);
        else for (const p of this.idx.pathsIn(dir)) recheck.push(p);
      }
    }
    // An index kept in place moves a note that is unchanged at its new path (keeping what it
    // knows of the note's text), before what is gone is removed.
    if (this.idx.inPlace) for (const [to, n] of reuse) {
      const f = seen.get(to);
      if (f && n.size === f.size && n.mtime === f.mtime && !this.idx.hasFile(to) && this.idx.moveNote(n.path, to)) changed = true;
    }
    // What the index has in those folders and is no longer there.
    for (const dir of outermost([...clear])) for (const p of this.idx.pathsIn(dir)) {
      if (seen.has(p)) continue;
      this.forget(p);
      this.idx.removeFile(p);
      if (MD.test(p)) this.save(p, null);
      changed = true;
    }
    const toRead: FileMeta[] = [];
    for (const f of seen.values()) {
      if (!MD.test(f.path)) {
        if (!this.idx.hasFile(f.path)) { this.idx.addAttachment(f.path); changed = true; }
        continue;
      }
      const at = this.idx.stampOf(f.path);
      if (at) { if (at.size !== f.size || at.mtime !== f.mtime) toRead.push(f); continue; }
      // An index kept in place has moved what it could; the rest is read, for its text.
      const c = this.idx.inPlace ? undefined : reuse.get(f.path);
      if (!c || c.size !== f.size || c.mtime !== f.mtime) { toRead.push(f); continue; }
      const note = { ...c, path: f.path };
      this.idx.upsertNote(note);
      this.save(f.path, note);
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
          this.save(f.path, note);
          changed = true;
        } catch { /* half-written or placeholder file: the next event will retry */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, toRead.length) }, work));
    if (await this.refreshPaths(recheck)) changed = true;
    clearInterned();
    return changed;
  }

  /** Everything the vault knows about one Roam page title. The lines of the first `withLines`
   *  linking notes come with their text; the others are marked `unread`, for lines() to read. */
  async query(title: string, withLines = Infinity): Promise<PageResult> {
    const a = this.matcher.associations(title);
    const counterparts: Counterpart[] = a.notes
      .filter((n) => TIER_LABEL[n.how])
      .sort((x, y) => TIER_ORDER.indexOf(x.how) - TIER_ORDER.indexOf(y.how) || x.path.localeCompare(y.path))
      .map((n) => ({ path: n.path, title: this.name(n.path), how: n.how, label: TIER_LABEL[n.how]! }));
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
    const backlinks: Backlink[] = [...bySrc]
      .map(([path, lines]): Backlink => ({ path, title: this.name(path), lines }))
      .sort((x, y) => x.title.localeCompare(y.title) || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
      .slice(0, MAX_BACKLINK_NOTES);
    for (const b of backlinks) b.lines.sort((x, y) => x.line - y.line);
    const first = backlinks.slice(0, withLines);
    const texts = await this.lines(first.map((b) => ({ path: b.path, lines: b.lines.map((l) => l.line) })));
    first.forEach((b, i) => texts[i]?.forEach((t, j) => putLine(b.lines[j], t)));
    for (let i = first.length; i < backlinks.length; i++) backlinks[i].unread = true;
    const srcs = backlinks.map((b) => b.path);
    const seenTag = new Set<string>();
    const tagged: Tagged[] = [];
    for (const t of a.tagged) if (!seenTag.has(t.path)) { seenTag.add(t.path); tagged.push({ path: t.path, title: this.name(t.path), tag: t.tag }); }
    tagged.sort((x, y) => x.title.localeCompare(y.title) || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    // Close names only for a page no note is: next to an exact match they would mostly be noise.
    const shown = new Set([...strong, ...srcs]);
    const inFolders = this.inFolders(title, shown);
    for (const n of inFolders) shown.add(n.path);
    for (const t of tagged) shown.add(t.path);
    const fuzzy = counterparts.length ? [] : this.fuzzy(title, MAX_FUZZY).filter((f) => !shown.has(f.path));
    return { title, counterparts, backlinks, tagged, inFolders, fuzzy, bundles: this.idx.bundleRoots() };
  }

  /** A note's name: in an OKF bundle its title, else its file name. */
  name(path: string): string {
    return (this.idx.bundleOf(path) !== null && this.idx.note(path)?.title) || noteTitle(path);
  }

  /** Notes whose name or alias is close to a page title, best first. */
  fuzzy(title: string, limit = 10): FuzzyNote[] {
    return (this.idx.fuzzy(title, limit) ?? (this.fuzzyIdx ??= new FuzzyIndex(this.idx)).match(title, limit)).map((h) => {
      const name = this.name(h.path);
      return { path: h.path, title: name, score: h.score, sim: h.sim, marks: h.kind === NAME ? diffMarks(name, title).flat() : [] };
    });
  }

  /** The text of some lines of some notes, as a page shows them. Null for a note that can't be read. */
  async lines(items: { path: string; lines: number[] }[]): Promise<(LineRead[] | null)[]> {
    const out: (LineRead[] | null)[] = items.map(() => null);
    for (let i = 0; i < items.length; i += READS_AT_ONCE) {
      await Promise.all(items.slice(i, i + READS_AT_ONCE).map(async (it, k) => {
        const text = await this.text(it.path);
        if (text !== null) out[i + k] = contextOf(text, it.lines, this.idx.bundleOf(it.path) !== null).map(({ text, line, up, kids, cut }) => ({ text, line, up, kids, ...(cut ? { cut } : {}) }));
      }));
    }
    return out;
  }

  /** The notes inside folders named like the page, without those the page lists already. The
   *  notes nearest the folder come first: its own notes, then each level of subfolders. */
  private inFolders(title: string, shown: Set<string>): FolderNote[] {
    // A folder inside one already found (a copy kept in a subfolder, say) is covered by that one.
    const dirs: string[] = [];
    for (const d of this.idx.foldersNamed(title)) if (!dirs.some((top) => d.startsWith(top + '/'))) dirs.push(d);
    const out: { path: string; title: string; from: number; depth: number }[] = [];
    // A page A/B is the last two folders of the path, a page B the last one.
    const parts = title.replace(/^\/+|\/+$/g, '').split('/').length;
    for (const dir of dirs) {
      let from = dir.length;
      for (let i = 0; i < parts && from > 0; i++) from = dir.lastIndexOf('/', from - 1);
      from = Math.max(from, -1) + 1;
      for (const path of this.idx.notePathsIn(dir)) {
        if (shown.has(path)) continue;
        let depth = 0;
        for (let i = dir.length + 1; (i = path.indexOf('/', i) + 1) > 0;) depth++;
        out.push({ path, title: this.name(path), from, depth });
      }
    }
    out.sort((x, y) => x.depth - y.depth || x.path.localeCompare(y.path));
    return out.slice(0, MAX_FOLDER_NOTES).map(({ path, title, from }) => ({ path, title, from }));
  }

  async read(path: string): Promise<string> { return this.fs.readText(path); }

  /** Resolve a [[link]] target as Obsidian would, from a given source note. */
  resolve(target: string, from: string): string | null {
    return this.idx.candidates(target, from).find((p) => MD.test(p)) ?? null;
  }

  /** The file an embed names that is not a note (an image), resolved the same way. */
  resolveFile(target: string, from: string): string | null {
    return this.idx.candidates(target, from).find((p) => !MD.test(p)) ?? null;
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
