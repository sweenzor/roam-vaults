// Vault index + Obsidian-like link resolver with incremental updates. No Node APIs.
//
// The index keeps one small record per note (see Note) and, for every link target name, the
// notes that link to it. Links are resolved when a page asks for them, not ahead of time: a
// record per link, each in two or three lookup sets, cost several times more memory than the
// rest of the index together, and had to be re-resolved whenever a file came or went.
import type { Note, ParsedNote } from './types.ts';

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
const baseOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); };

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
  for (const l of p.links) if (l.target !== '') links.push(l.target, l.line * 2 + (l.embed ? 1 : 0));
  // slice(): an array that grew by push keeps room for more, and there is one of these per note
  return {
    path: p.path, size, mtime,
    aliases: p.aliases.length ? p.aliases.slice() : NONE,
    tags: p.tags.length ? p.tags.slice() : NONE,
    links: links.length ? links.slice() : NONE,
  };
}

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
  /** Every folder that holds a file, at any depth -> how many files are under it. */
  dirs = new Map<string, number>();
  /** nfcLower(folder name) -> the folders with that name. */
  dirByName = new Map<string, string[]>();
  listeners: FileListener[] = [];
  /** Tie-break duplicates by shared folder prefix with the linking note (not Obsidian behaviour; see report). */
  preferNearby = false;

  // ---------- file registry ----------
  private register(path: string): string {
    path = path.normalize('NFC');
    const nameKey = baseOf(fileKeyPath(path));
    this.files.set(path, nameKey);
    const arr = this.byName.get(nameKey);
    if (arr) arr.push(path); else this.byName.set(nameKey, [path]);
    for (let d = dirOf(path); d; d = dirOf(d)) {
      const n = this.dirs.get(d);
      this.dirs.set(d, (n ?? 0) + 1);
      if (n === undefined) push(this.dirByName, nfcLower(baseOf(d)), d);
    }
    return nameKey;
  }
  private unregister(path: string): string | undefined {
    const nameKey = this.files.get(path);
    if (nameKey === undefined) return;
    this.files.delete(path);
    const arr = this.byName.get(nameKey)!;
    arr.splice(arr.indexOf(path), 1);
    if (!arr.length) this.byName.delete(nameKey);
    for (let d = dirOf(path); d; d = dirOf(d)) {
      const n = this.dirs.get(d)! - 1;
      if (n) { this.dirs.set(d, n); continue; }
      this.dirs.delete(d);
      pull(this.dirByName, nfcLower(baseOf(d)), d);
    }
    return nameKey;
  }

  /** Folders a page title names: same folder name in any letter case, or for a namespaced
   *  title "A/B", a folder whose path ends in a/b. */
  foldersNamed(title: string): string[] {
    const key = nfcLower(title.normalize('NFC')).replace(/^\/+|\/+$/g, '');
    if (!key) return [];
    const cands = this.dirByName.get(baseOf(key)) ?? NONE;
    const hit = key.includes('/') ? cands.filter((d) => { const k = nfcLower(d); return k === key || k.endsWith('/' + key); }) : cands.slice();
    return hit.sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
  }

  /** The files under a folder, at any depth. */
  filesUnder(dir: string): string[] {
    const pre = dir + '/', out: string[] = [];
    for (const p of this.files.keys()) if (p.startsWith(pre)) out.push(p);
    return out;
  }

  // ---------- resolution ----------
  /** All files a link target could mean, best first. */
  candidates(target: string, src: string): string[] {
    if (target === '') return [src];
    let t = target.normalize('NFC');
    if (t.startsWith('./') || t.startsWith('../')) {
      const j = joinRel(dirOf(src), t);
      if (j === null) return [];
      t = j;
    }
    const key = linkKey(t);
    const nameKey = baseOf(key);
    let cands = this.byName.get(nameKey);
    if (!cands || !cands.length) return [];
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
  private keyOf(target: string, src: string): string {
    return linkKey(target.startsWith('./') || target.startsWith('../') ? (joinRel(dirOf(src), target) ?? target) : target);
  }

  /** Links from other notes that resolve to one of these files. */
  backlinks(paths: Iterable<string>): LinkHit[] {
    const want = new Set(paths);
    const names = new Set<string>();
    for (const p of want) { const k = this.files.get(p); if (k !== undefined) names.add(k); }
    const out: LinkHit[] = [];
    // The same target written in the same folder resolves the same way.
    const memo = new Map<string, string | null>();
    for (const name of names) {
      const at = this.linkers.get(name) ?? NONE;
      for (let j = 0; j < at.length; j += 2) {
        const n = at[j] as Note, i = at[j + 1] as number;
        const target = n.links[i] as string, where = n.links[i + 1] as number;
        const mk = `${dirOf(n.path)}\n${target}`;
        let to = memo.get(mk);
        if (to === undefined) memo.set(mk, to = this.candidates(target, n.path)[0] ?? null);
        if (to === null || to === n.path || !want.has(to)) continue;
        out.push({ src: n.path, line: where >> 1, embed: (where & 1) === 1, resolved: to });
      }
    }
    return out;
  }

  /** Links written as this text (a linkKey) that resolve to no file. */
  unresolved(key: string): LinkHit[] {
    const out: LinkHit[] = [];
    const at = this.linkers.get(baseOf(key)) ?? NONE;
    for (let j = 0; j < at.length; j += 2) {
      const n = at[j] as Note, i = at[j + 1] as number;
      const target = n.links[i] as string, where = n.links[i + 1] as number;
      if (this.keyOf(target, n.path) !== key || this.candidates(target, n.path).length) continue;
      out.push({ src: n.path, line: where >> 1, embed: (where & 1) === 1, resolved: null });
    }
    return out;
  }

  /** What each link in a note resolves to, in the order they are written. */
  outgoing(path: string): (string | null)[] {
    const out: (string | null)[] = [];
    const l = this.notes.get(path)?.links ?? NONE;
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

  // ---------- public API ----------
  build(notes: Note[], attachments: string[]) {
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
function aliasKeys(note: Note): string[] {
  if (!note.aliases.length) return NONE;
  return [...new Set(note.aliases.map(nfcLower))];
}
function noteTagKeys(note: Note): string[] {
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
