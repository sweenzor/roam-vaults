// Vault index + Obsidian-like link resolver with incremental updates. No Node APIs.
//
// The index keeps one small record per note (see Note) and, for every link target name, the
// notes that link to it. Links are resolved when a page asks for them, not ahead of time: a
// record per link, each in two or three lookup sets, cost several times more memory than the
// rest of the index together, and had to be re-resolved whenever a file came or went.
import { F_OKF, type Note, type ParsedNote } from './types.ts';

export interface LinkHit {
  src: string;            // the note the link is in
  line: number;           // 0-based line in that note
  embed: boolean;
  resolved: string | null;
}

const MD = /\.md$/i;
/** The one empty list every note without links, tags or aliases shares. */
export const NONE: never[] = Object.freeze([]) as never[];
export const nfcLower = (s: string) => s.normalize('NFC').toLowerCase();
const dirOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
export const baseOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); };

/** Key for a link target: "Folder/Note.md" -> "folder/note"; "img.PNG" -> "img.png". */
export function linkKey(target: string): string {
  let t = nfcLower(target).replace(/^\/+/, '');
  if (MD.test(t)) t = t.slice(0, -3);
  return t;
}
/** Key for a file path: md files lose the extension, attachments keep it. */
export function fileKeyPath(path: string): string {
  const t = nfcLower(path);
  return MD.test(t) ? t.slice(0, -3) : t;
}

function joinRel(dir: string, rel: string): string | null {
  const out = dir ? dir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
  }
  return out.join('/');
}

/** Reduce a parsed note to what the index keeps. */
export function toNote(p: ParsedNote, size = 0, mtime = 0): Note {
  const links: (string | number)[] = [];
  for (const l of p.links) if (l.target !== '') links.push(l.target, l.flags & F_OKF ? -1 - l.line : l.line * 2 + (l.embed ? 1 : 0));
  // slice(): an array that grew by push keeps room for more, and there is one of these per note
  const note: Note = {
    path: p.path, size, mtime,
    aliases: p.aliases.length ? p.aliases.slice() : NONE,
    tags: p.tags.length ? p.tags.slice() : NONE,
    links: links.length ? links.slice() : NONE,
  };
  const title = titleOf(p.props);
  if (title) note.title = title;
  if (/(^|\/)index\.md$/i.test(p.path) && p.props?.okf_version) note.root = true;
  return note;
}

/** A note's frontmatter `title`, unquoted. */
export function titleOf(props: Record<string, string | string[]> | null): string {
  const t = props && typeof props.title === 'string' ? props.title : '';
  return t.trim().replace(/^(["'])(.*)\1$/, '$2').trim().normalize('NFC');
}

export interface Stamp { size: number; mtime: number }
export type FileListener = (path: string, kind: 'add' | 'remove' | 'update') => void;

export class VaultIndex {
  /** Every file in the vault -> its name key (lowercase file name; notes without ".md"). */
  files = new Map<string, string>();
  notes = new Map<string, Note>();
  byName = new Map<string, string[]>();                 // name key -> paths
  /** Name key of a link target -> where such links are, resolved or not, as flat pairs:
   *  the note, then the position of the link's target in note.links. */
  linkers = new Map<string, (Note | number)[]>();
  aliasIdx = new Map<string, string[]>();               // nfcLower(alias) -> paths
  tagIdx = new Map<string, string[]>();                 // nfcLower(tag) -> paths (incl. parent tags)
  listeners: FileListener[] = [];
  /** Tie-break duplicates by shared folder prefix with the linking note (not Obsidian behaviour; see report). */
  preferNearby = false;

  constructor() {
    // A file named index.md came, went or changed: the bundles are worked out again when asked.
    this.listeners.push((p) => { if (/(^|\/)index\.md$/i.test(p)) this.roots = null; });
  }

  // ---------- OKF bundles ----------
  /** The folders that are an OKF bundle's root (an index.md there says okf_version), deepest first;
   *  '' is the vault's own folder. Null: not worked out since an index.md last changed. */
  protected roots: string[] | null = null;
  bundleRoots(): string[] {
    if (!this.roots) {
      this.roots = this.pathsNamed('index').filter((p) => /(^|\/)index\.md$/i.test(p) && this.note(p)?.root).map(dirOf)
        .sort((a, b) => b.length - a.length);
    }
    return this.roots;
  }
  /** The root of the OKF bundle a file is in, or null when it is in none. */
  bundleOf(path: string): string | null {
    for (const r of this.bundleRoots()) if (r === '' || path.startsWith(r + '/')) return r;
    return null;
  }

  // ---------- file registry ----------
  protected register(path: string): string {
    path = path.normalize('NFC');
    const nameKey = baseOf(fileKeyPath(path));
    this.files.set(path, nameKey);
    const arr = this.byName.get(nameKey);
    if (arr) arr.push(path); else this.byName.set(nameKey, [path]);
    return nameKey;
  }
  protected unregister(path: string): string | undefined {
    const nameKey = this.files.get(path);
    if (nameKey === undefined) return;
    this.files.delete(path);
    const arr = this.byName.get(nameKey)!;
    arr.splice(arr.indexOf(path), 1);
    if (!arr.length) this.byName.delete(nameKey);
    return nameKey;
  }

  // ---------- resolution ----------
  /** All files a link target could mean, best first. */
  candidates(target: string, src: string): string[] {
    if (target === '') return [src];
    let t = target.normalize('NFC');
    // In an OKF bundle a path is read from the linking file's folder, or from the bundle's root when
    // it starts with '/'. What it names is taken first; if there is nothing there, as a vault reads it.
    const root = this.roots?.length === 0 ? null : this.bundleOf(src);
    if (root !== null && !t.startsWith('./') && !t.startsWith('../')) {
      const j = t.startsWith('/') ? joinRel(root, t) : joinRel(dirOf(src), t);
      if (j) {
        const key = linkKey(j);
        const hit = this.pathsNamed(baseOf(key)).filter((p) => fileKeyPath(p) === key);
        if (hit.length) return hit.slice();
      }
    }
    if (t.startsWith('./') || t.startsWith('../')) {
      const j = joinRel(dirOf(src), t);
      if (j === null) return [];
      t = j;
    }
    const key = linkKey(t);
    const nameKey = baseOf(key);
    let cands: readonly string[] = this.pathsNamed(nameKey);
    if (!cands.length) return [];
    if (key.includes('/')) {
      const exact = cands.filter((p) => fileKeyPath(p) === key);
      if (exact.length) return exact;
      const rel = joinRel(nfcLower(dirOf(src)), key);
      const relHit = rel ? cands.filter((p) => fileKeyPath(p) === rel) : [];
      if (relHit.length) return relHit;
      cands = cands.filter((p) => fileKeyPath(p).endsWith('/' + key));
      if (!cands.length) return [];
    }
    if (cands.length === 1) return cands.slice();
    // tie-break: exact-case basename, same folder as source, shallowest, shortest, lexicographic
    const wantBase = baseOf(t.replace(/^\/+/, '')).replace(MD, '');
    const srcDir = dirOf(src);
    return cands.slice().sort((a, b) => {
      const ca = baseOf(a).replace(MD, '') === wantBase ? 0 : 1, cb = baseOf(b).replace(MD, '') === wantBase ? 0 : 1;
      if (ca !== cb) return ca - cb;
      const sa = dirOf(a) === srcDir ? 0 : 1, sb = dirOf(b) === srcDir ? 0 : 1;
      if (sa !== sb) return sa - sb;
      if (this.preferNearby) { // longest shared folder prefix with the source (keeps de/ links in de/)
        const pa = commonDirs(a, src), pb = commonDirs(b, src);
        if (pa !== pb) return pb - pa;
      }
      const da = depth(a), db = depth(b);
      if (da !== db) return da - db;
      if (a.length !== b.length) return a.length - b.length;
      return a < b ? -1 : 1;
    });
  }

  /** Normalized link text of a target written in the note at src (lowercase, NFC, no leading
   *  '/', no .md): what an unresolved link is looked up by. Its file-name part is the name key. */
  protected keyOf(target: string, src: string): string {
    return linkKey(target.startsWith('./') || target.startsWith('../') ? (joinRel(dirOf(src), target) ?? target) : target);
  }

  /** Links from other notes that resolve to one of these files. */
  backlinks(paths: Iterable<string>): LinkHit[] {
    const want = new Set(paths);
    const names = new Set<string>();
    for (const p of want) { const k = this.nameOf(p); if (k !== undefined) names.add(k); }
    const out: LinkHit[] = [];
    // The same target written in the same folder resolves the same way.
    const memo = new Map<string, string | null>();
    for (const name of names) {
      this.eachLinker(name, (src, target, where) => {
        const mk = `${dirOf(src)}\n${target}`;
        let to = memo.get(mk);
        if (to === undefined) memo.set(mk, to = this.candidates(target, src)[0] ?? null);
        if (to === null || to === src || !want.has(to) || !this.counts(where, src)) return;
        out.push({ src, line: lineOf(where), embed: where > 0 && (where & 1) === 1, resolved: to });
      });
    }
    return out;
  }

  /** Does a link count? One that only an OKF bundle has (a type or status) counts in a bundle. */
  private counts(where: number, src: string): boolean { return where >= 0 || this.bundleOf(src) !== null; }

  /** Links written as this text (a linkKey) that resolve to no file. */
  unresolved(key: string): LinkHit[] {
    const out: LinkHit[] = [];
    this.eachLinker(baseOf(key), (src, target, where) => {
      if (this.keyOf(target, src) !== key || !this.counts(where, src) || this.candidates(target, src).length) return;
      out.push({ src, line: lineOf(where), embed: where > 0 && (where & 1) === 1, resolved: null });
    });
    return out;
  }

  /** What each link in a note resolves to, in the order they are written. */
  outgoing(path: string): (string | null)[] {
    const out: (string | null)[] = [];
    const l = this.note(path)?.links ?? NONE;
    for (let i = 0; i < l.length; i += 2) out.push(this.candidates(l[i] as string, path)[0] ?? null);
    return out;
  }

  // ---------- note contributions ----------
  private addContrib(note: Note) {
    const l = note.links;
    for (let i = 0; i < l.length; i += 2) {
      const name = baseOf(this.keyOf(l[i] as string, note.path));
      const at = this.linkers.get(name);
      if (at) at.push(note, i); else this.linkers.set(name, [note, i]);
    }
    for (const k of aliasKeys(note)) push(this.aliasIdx, k, note.path);
    for (const k of noteTagKeys(note)) push(this.tagIdx, k, note.path);
  }
  private removeContrib(path: string) {
    const note = this.notes.get(path);
    if (!note) return;
    const l = note.links, names = new Set<string>();
    for (let i = 0; i < l.length; i += 2) names.add(baseOf(this.keyOf(l[i] as string, path)));
    for (const name of names) {
      const at = this.linkers.get(name);
      if (!at) continue;
      let w = 0;
      for (let r = 0; r < at.length; r += 2) if (at[r] !== note) { at[w++] = at[r]; at[w++] = at[r + 1]; }
      at.length = w;
      if (!w) this.linkers.delete(name);
    }
    for (const k of aliasKeys(note)) pull(this.aliasIdx, k, path);
    for (const k of noteTagKeys(note)) pull(this.tagIdx, k, path);
  }

  // ---------- lookups ----------
  // Everything the resolver and the matcher ask of the index goes through these, so another store
  // (src/sql/sql-index.ts keeps the same index in SQLite) can answer them instead of the maps above.
  hasFile(path: string): boolean { return this.files.has(path); }
  /** A file's name key (lowercase file name; notes without ".md"). */
  nameOf(path: string): string | undefined { return this.files.get(path); }
  /** Every file with this name key. */
  pathsNamed(nameKey: string): readonly string[] { return this.byName.get(nameKey) ?? NONE; }
  /** Every link whose target's file-name part is this name key, resolved or not. */
  eachLinker(name: string, fn: (src: string, target: string, where: number) => void) {
    const at = this.linkers.get(name) ?? NONE;
    for (let j = 0; j < at.length; j += 2) {
      const n = at[j] as Note, i = at[j + 1] as number;
      fn(n.path, n.links[i] as string, n.links[i + 1] as number);
    }
  }
  aliasPaths(key: string): readonly string[] { return this.aliasIdx.get(key) ?? NONE; }
  tagPaths(key: string): readonly string[] { return this.tagIdx.get(key) ?? NONE; }
  /** Notes whose name or alias is close to a page title. Null: the engine's FuzzyIndex does it
   *  (only the SQLite index answers this itself). */
  fuzzy(_title: string, _limit: number): { path: string; score: number; sim: number; kind: number }[] | null { return null; }
  note(path: string): Note | undefined { return this.notes.get(path); }
  /** A note's file size and time when it was read, if it is in the index. */
  stampOf(path: string): Stamp | undefined { return this.notes.get(path); }
  noteCount(): number { return this.notes.size; }
  /** Does the index hold no file at all? */
  isEmpty(): boolean { return !this.files.size; }
  /** Every path in the vault, notes and attachments. */
  filePaths(): string[] { return [...this.files.keys()]; }
  notePaths(): Iterable<string> { return this.notes.keys(); }
  /** The notes inside a folder, at any depth. */
  notesIn(folder: string): Note[] {
    const out: Note[] = [];
    for (const [p, n] of this.notes) if (p.startsWith(folder + '/')) out.push(n);
    return out;
  }
  /** Lookup keys the matcher adds per note (daily-note dates, for one), path by key. */
  private extra = new Map<string, string[]>();
  addKey(key: string, path: string) { push(this.extra, key, path); }
  removeKey(key: string, path: string) { pull(this.extra, key, path); }
  keyPaths(key: string): readonly string[] { return this.extra.get(key) ?? NONE; }
  /** Are the matcher's keys made with these settings already there? Maps start empty: never. */
  keysMadeWith(_settings: string): boolean { return false; }
  /** Add or update several notes. */
  upsertNotes(notes: Note[]) { for (const n of notes) this.upsertNote(n); }
  /** Every file by path, with a note's file size and time when it was read (null for an attachment).
   *  An index that takes a while over it may answer later, and do other work meanwhile. */
  stamps(): Map<string, Stamp | null> | Promise<Map<string, Stamp | null>> {
    const out = new Map<string, Stamp | null>();
    for (const p of this.files.keys()) out.set(p, this.notes.get(p) ?? null);
    return out;
  }
  /** Every path inside a folder, at any depth. */
  pathsIn(folder: string): string[] {
    const out: string[] = [];
    for (const p of this.files.keys()) if (p.startsWith(folder + '/')) out.push(p);
    return out;
  }
  /** Move a note to a path that has no file, keeping what is known of it. False if there was none. */
  moveNote(from: string, to: string): boolean {
    const n = this.note(from);
    if (!n || this.hasFile(to)) return false;
    this.removeFile(from);
    this.upsertNote({ ...n, path: to });
    return true;
  }
  /** Is the index kept in place across scans (a database) instead of built anew each time? */
  readonly inPlace: boolean = false;
  /** Writes are complete for now (a store that batches them commits). */
  flush() {}
  /** Many notes are about to be written to an empty index (true), or have been (false). */
  bulk(_on: boolean) {}

  // ---------- public API ----------
  build(notes: Note[], attachments: string[]) {
    this.roots = null;
    for (const p of attachments) this.register(p);
    for (const n of notes) { this.register(n.path); this.notes.set(n.path, n); }
    for (const n of notes) this.addContrib(n);
    // Lists that grew one entry at a time keep spare room: trim them once everything is in.
    for (const m of [this.linkers, this.aliasIdx, this.tagIdx] as Map<string, unknown[]>[]) {
      for (const [k, list] of m) if (list.length > 1) m.set(k, list.slice());
    }
  }

  /** Add or update a note. */
  upsertNote(note: Note) {
    const isNew = !this.files.has(note.path);
    if (isNew) this.register(note.path); else this.removeContrib(note.path);
    this.notes.set(note.path, note);
    this.addContrib(note);
    for (const l of this.listeners) l(note.path, isNew ? 'add' : 'update');
  }
  addAttachment(path: string) {
    if (this.files.has(path)) return;
    this.register(path);
    for (const l of this.listeners) l(path, 'add');
  }
  removeFile(path: string) {
    this.removeContrib(path);
    for (const l of this.listeners) l(path, 'remove');
    this.notes.delete(path);
    this.unregister(path);
  }
}

const depth = (p: string) => p.split('/').length;
/** The line a link is on, from where it is (see Note.links). */
const lineOf = (where: number) => where < 0 ? -1 - where : where >> 1;
function commonDirs(a: string, b: string): number {
  const x = a.split('/'), y = b.split('/');
  let n = 0;
  while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++;
  return n;
}

/** "a/b/c" -> ["a/b/c", "a/b", "a"] (Obsidian nested tags match their parents). */
export function tagKeys(tag: string): string[] {
  const k = nfcLower(tag);
  const out = [k];
  for (let i = k.lastIndexOf('/'); i > 0; i = k.lastIndexOf('/', i - 1)) out.push(k.slice(0, i));
  return out;
}

/** The keys a note is listed under, each once (so it is added and removed exactly once). */
export function aliasKeys(note: Note): string[] {
  if (!note.aliases.length) return NONE;
  return [...new Set(note.aliases.map(nfcLower))];
}
export function noteTagKeys(note: Note): string[] {
  if (!note.tags.length) return NONE;
  const out = new Set<string>();
  for (const t of note.tags) for (const k of tagKeys(t)) out.add(k);
  return [...out];
}

function push<V>(m: Map<string, V[]>, k: string, v: V) { const list = m.get(k); if (list) list.push(v); else m.set(k, [v]); }
function pull<V>(m: Map<string, V[]>, k: string, v: V) {
  const list = m.get(k);
  if (!list) return;
  const i = list.indexOf(v);
  if (i >= 0) { list[i] = list[list.length - 1]; list.pop(); }
  if (!list.length) m.delete(k);
}
