// Vault index + Obsidian-like link resolver with incremental updates. No Node APIs.
import type { Link, ParsedNote } from './types.ts';
import { intern } from './parser.ts';

export interface LinkRec {
  src: string;            // source note path
  link: Link;
  key: string;            // normalized linkpath (lowercase, NFC, no leading '/', no .md); '' = self
  nameKey: string;        // basename part of key: bucket used for incremental re-resolution
  resolved: string | null;
  candidates: number;     // >1 => ambiguous (tie-broken)
}

interface FileEntry { path: string; keyPath: string; nameKey: string; isMd: boolean; depth: number }

const MD = /\.md$/i;
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

export type FileListener = (path: string, kind: 'add' | 'remove' | 'update') => void;

export class VaultIndex {
  files = new Map<string, FileEntry>();
  notes = new Map<string, ParsedNote>();
  byName = new Map<string, string[]>();                 // nameKey -> paths
  outgoing = new Map<string, LinkRec[]>();              // src -> recs
  backlinks = new Map<string, Set<LinkRec>>();          // resolved target path -> recs
  unresolved = new Map<string, Set<LinkRec>>();         // link key -> recs
  byLinkName = new Map<string, Set<LinkRec>>();         // nameKey -> recs (resolved or not)
  aliasIdx = new Map<string, Set<string>>();            // nfcLower(alias) -> paths
  tagIdx = new Map<string, Set<string>>();              // nfcLower(tag) -> paths (incl. parent tags)
  listeners: FileListener[] = [];
  /** Tie-break duplicates by shared folder prefix with the linking note (not Obsidian behaviour; see report). */
  preferNearby = false;

  // ---------- file registry ----------
  private register(path: string): FileEntry {
    path = path.normalize('NFC');
    const keyPath = fileKeyPath(path);
    const e: FileEntry = { path, keyPath, nameKey: baseOf(keyPath), isMd: MD.test(path), depth: path.split('/').length };
    this.files.set(path, e);
    const arr = this.byName.get(e.nameKey);
    if (arr) arr.push(path); else this.byName.set(e.nameKey, [path]);
    return e;
  }
  private unregister(path: string): FileEntry | undefined {
    const e = this.files.get(path);
    if (!e) return;
    this.files.delete(path);
    const arr = this.byName.get(e.nameKey)!;
    arr.splice(arr.indexOf(path), 1);
    if (!arr.length) this.byName.delete(e.nameKey);
    return e;
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
      const exact = cands.filter((p) => this.files.get(p)!.keyPath === key);
      if (exact.length) return exact;
      const rel = joinRel(nfcLower(dirOf(src)), key);
      const relHit = rel ? cands.filter((p) => this.files.get(p)!.keyPath === rel) : [];
      if (relHit.length) return relHit;
      cands = cands.filter((p) => this.files.get(p)!.keyPath.endsWith('/' + key));
      if (!cands.length) return [];
    }
    if (cands.length === 1) return cands.slice();
    // tie-break: exact-case basename, same folder as source, shallowest, shortest, lexicographic
    const wantBase = baseOf(t.replace(/^\/+/, '')).replace(MD, '');
    const srcDir = dirOf(src);
    return cands.slice().sort((a, b) => {
      const ea = this.files.get(a)!, eb = this.files.get(b)!;
      const ca = baseOf(a).replace(MD, '') === wantBase ? 0 : 1, cb = baseOf(b).replace(MD, '') === wantBase ? 0 : 1;
      if (ca !== cb) return ca - cb;
      const sa = dirOf(a) === srcDir ? 0 : 1, sb = dirOf(b) === srcDir ? 0 : 1;
      if (sa !== sb) return sa - sb;
      if (this.preferNearby) { // longest shared folder prefix with the source (keeps de/ links in de/)
        const pa = commonDirs(a, src), pb = commonDirs(b, src);
        if (pa !== pb) return pb - pa;
      }
      if (ea.depth !== eb.depth) return ea.depth - eb.depth;
      if (a.length !== b.length) return a.length - b.length;
      return a < b ? -1 : 1;
    });
  }

  private resolveRec(r: LinkRec) {
    const c = this.candidates(r.link.target, r.src);
    r.resolved = c.length ? c[0] : null;
    r.candidates = c.length;
    if (r.resolved !== null) add(this.backlinks, r.resolved, r);
    else add(this.unresolved, r.key, r);
  }
  private unresolveRec(r: LinkRec) {
    if (r.resolved !== null) del(this.backlinks, r.resolved, r);
    else del(this.unresolved, r.key, r);
  }
  private reresolveBucket(nameKey: string) {
    const bucket = this.byLinkName.get(nameKey);
    if (!bucket) return 0;
    for (const r of bucket) { this.unresolveRec(r); this.resolveRec(r); }
    return bucket.size;
  }

  // ---------- note contributions ----------
  private addContrib(note: ParsedNote) {
    const recs: LinkRec[] = [];
    for (const link of note.links) {
      const key = link.target === '' ? '' : linkKey(/^\.\.?\//.test(link.target) ? (joinRel(dirOf(note.path), link.target) ?? link.target) : link.target);
      const r: LinkRec = { src: note.path, link, key: intern(key), nameKey: intern(baseOf(key)), resolved: null, candidates: 0 };
      recs.push(r);
      if (key !== '') add(this.byLinkName, r.nameKey, r);
      this.resolveRec(r);
    }
    this.outgoing.set(note.path, recs);
    for (const a of note.aliases) add(this.aliasIdx, nfcLower(a), note.path);
    for (const t of note.tags) for (const k of tagKeys(t)) add(this.tagIdx, k, note.path);
  }
  private removeContrib(path: string) {
    const recs = this.outgoing.get(path);
    if (recs) for (const r of recs) { this.unresolveRec(r); if (r.key !== '') del(this.byLinkName, r.nameKey, r); }
    this.outgoing.delete(path);
    const note = this.notes.get(path);
    if (note) {
      for (const a of note.aliases) del(this.aliasIdx, nfcLower(a), path);
      for (const t of note.tags) for (const k of tagKeys(t)) del(this.tagIdx, k, path);
    }
  }

  // ---------- public API ----------
  /** Bulk build: register every name first so no re-resolution churn. */
  build(notes: ParsedNote[], attachments: string[]) {
    for (const p of attachments) this.register(p);
    for (const n of notes) { this.register(n.path); this.notes.set(n.path, n); }
    for (const n of notes) this.addContrib(n);
  }

  /** Add or update a note. Returns number of other links re-resolved. */
  upsertNote(note: ParsedNote): number {
    let rer = 0;
    const isNew = !this.files.has(note.path);
    if (isNew) {
      const e = this.register(note.path);
      rer = this.reresolveBucket(e.nameKey);
    } else this.removeContrib(note.path);
    this.notes.set(note.path, note);
    this.addContrib(note);
    for (const l of this.listeners) l(note.path, isNew ? 'add' : 'update');
    return rer;
  }
  addAttachment(path: string): number {
    if (this.files.has(path)) return 0;
    const e = this.register(path);
    for (const l of this.listeners) l(path, 'add');
    return this.reresolveBucket(e.nameKey);
  }
  removeFile(path: string): number {
    this.removeContrib(path);
    for (const l of this.listeners) l(path, 'remove');
    this.notes.delete(path);
    const e = this.unregister(path);
    return e ? this.reresolveBucket(e.nameKey) : 0;
  }

  /** Compact, JSON-serializable form (parsed notes only; maps are rebuilt on load). */
  toJSON() {
    return { v: 1, attachments: [...this.files.values()].filter((e) => !e.isMd).map((e) => e.path), notes: [...this.notes.values()] };
  }
  static fromJSON(j: { attachments: string[]; notes: ParsedNote[] }): VaultIndex {
    const idx = new VaultIndex();
    idx.build(j.notes, j.attachments);
    return idx;
  }
}

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

function add<K, V>(m: Map<K, Set<V>>, k: K, v: V) { const s = m.get(k); if (s) s.add(v); else m.set(k, new Set([v])); }
function del<K, V>(m: Map<K, Set<V>>, k: K, v: V) { const s = m.get(k); if (!s) return; s.delete(v); if (!s.size) m.delete(k); }
