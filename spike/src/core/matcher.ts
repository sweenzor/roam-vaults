// Roam page title -> vault associations. No Node APIs.
import { VaultIndex, type LinkRec, nfcLower, linkKey, fileKeyPath } from './vault-index.ts';
import { compileFormat, parseWithFormat, roamDailyToIso, formatIso, type DateFormat } from './dates.ts';

export type NoteHow =
  | 'exact'          // basename === title (after NFC)
  | 'case'           // case-insensitive basename
  | 'path'           // namespace title "A/B" == vault path suffix a/b.md
  | 'alias'          // frontmatter alias
  | 'daily'          // Roam daily title <-> vault daily-note format
  | 'sanitized'      // title with filename-illegal chars removed (What is X? <-> What is X.md)
  | 'ns-flat'        // "A/B" <-> "A-B.md" / "A_B.md" / "A∕B.md" ...
  | 'loose';         // punctuation/space-insensitive (suggestion tier, off by default)

export interface NoteMatch { path: string; how: NoteHow }
export interface LinkMatch {
  src: string; line: number; col: number; kind: string; embed: boolean;
  target: string; subpath: string; snippet?: string;
  resolvedTo: string | null;      // null => unresolved link (only exists as text in the vault)
  via: 'backlink' | 'unresolved' | 'daily-unresolved';
}
export interface Associations { title: string; notes: NoteMatch[]; links: LinkMatch[]; tagged: { path: string; tag: string }[] }

export interface MatcherOptions { dailyFormats: string[]; loose?: boolean; nsSeparators?: string[] }

const ILLEGAL = /[\\/:*?"<>|#^\[\]]/g;           // illegal in Obsidian file names / link targets
export const sanitizedKey = (s: string) => nfcLower(s).replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim();
export const looseKey = (s: string) => nfcLower(s).replace(/[^\p{L}\p{N}]+/gu, '');

export class RoamMatcher {
  idx: VaultIndex;
  opts: MatcherOptions;
  formats: DateFormat[];
  sanitized = new Map<string, Set<string>>();
  loose = new Map<string, Set<string>>();
  daily = new Map<string, Set<string>>();          // iso -> paths
  nsSeps: string[];

  constructor(idx: VaultIndex, opts: MatcherOptions) {
    this.idx = idx; this.opts = opts;
    this.formats = opts.dailyFormats.map(compileFormat);
    this.nsSeps = opts.nsSeparators ?? ['-', '_', ' - ', '∕', '／', '.', ' '];
    for (const p of idx.notes.keys()) this.addPath(p);
    idx.listeners.push((p, kind) => {
      if (kind === 'add') this.addPath(p);
      else if (kind === 'remove') this.removePath(p);
    });
  }
  private keysFor(path: string) {
    const kp = fileKeyPath(path);
    const base = kp.slice(kp.lastIndexOf('/') + 1);
    const isos: string[] = [];
    for (const f of this.formats) { const iso = parseWithFormat(path.replace(/\.md$/i, ''), f); if (iso) isos.push(iso); }
    return { s: sanitizedKey(base), l: looseKey(base), isos };
  }
  private addPath(p: string) {
    if (!/\.md$/i.test(p)) return;
    const k = this.keysFor(p);
    add(this.sanitized, k.s, p);
    if (this.opts.loose) add(this.loose, k.l, p);
    for (const iso of k.isos) add(this.daily, iso, p);
  }
  private removePath(p: string) {
    if (!/\.md$/i.test(p)) return;
    const k = this.keysFor(p);
    del(this.sanitized, k.s, p); del(this.loose, k.l, p);
    for (const iso of k.isos) del(this.daily, iso, p);
  }

  associations(title: string): Associations {
    const idx = this.idx;
    const t = title.normalize('NFC').trim();
    const notes = new Map<string, NoteHow>();
    const put = (p: string, how: NoteHow) => { if (!notes.has(p)) notes.set(p, how); };

    // (a)(b)(f) name / case / namespace-path tiers come straight from the resolver
    if (!/[\[\]|#^]/.test(t)) {
      for (const p of idx.candidates(t, '')) {
        if (!/\.md$/i.test(p)) continue;
        const base = p.slice(p.lastIndexOf('/') + 1, -3);
        put(p, t.includes('/') ? 'path' : base === t ? 'exact' : 'case');
      }
    }
    // (c) aliases
    for (const p of idx.aliasIdx.get(nfcLower(t)) ?? []) put(p, 'alias');
    // (e) daily notes
    const iso = roamDailyToIso(t);
    if (iso) for (const p of this.daily.get(iso) ?? []) put(p, 'daily');
    // (f) namespace flattened into a single file name
    if (t.includes('/')) for (const sep of this.nsSeps) {
      for (const p of idx.byName.get(nfcLower(t.split('/').join(sep))) ?? []) if (/\.md$/i.test(p)) put(p, 'ns-flat');
    }
    // sanitized (illegal chars) tier
    for (const p of this.sanitized.get(sanitizedKey(t)) ?? []) put(p, 'sanitized');
    if (this.opts.loose) for (const p of this.loose.get(looseKey(t)) ?? []) put(p, 'loose');

    // (d) notes that link to it: backlinks of every matched note + unresolved links by text
    const seen = new Set<LinkRec>();
    const links: LinkMatch[] = [];
    const emit = (r: LinkRec, via: LinkMatch['via']) => {
      if (seen.has(r) || r.src === r.resolved && r.link.target === '') return;
      seen.add(r);
      links.push({ src: r.src, line: r.link.line, col: r.link.col, kind: r.link.kind, embed: r.link.embed, target: r.link.target,
        subpath: r.link.subpath, snippet: r.link.snippet, resolvedTo: r.resolved, via });
    };
    for (const p of notes.keys()) for (const r of idx.backlinks.get(p) ?? []) if (r.src !== p) emit(r, 'backlink');
    for (const r of idx.unresolved.get(linkKey(t)) ?? []) emit(r, 'unresolved');
    if (iso) for (const f of this.opts.dailyFormats) for (const r of idx.unresolved.get(linkKey(formatIso(iso, f))) ?? []) emit(r, 'daily-unresolved');

    // tags: Roam treats #tag and [[tag]] as the same page
    const tagged: { path: string; tag: string }[] = [];
    const tk = nfcLower(t);
    const tagVariants = t.includes(' ') ? [tk, tk.replace(/ /g, '-'), tk.replace(/ /g, '_')] : [tk];
    for (const v of tagVariants) for (const p of idx.tagIdx.get(v) ?? []) tagged.push({ path: p, tag: v });

    return { title, notes: [...notes].map(([path, how]) => ({ path, how })), links, tagged };
  }
}

function add<K, V>(m: Map<K, Set<V>>, k: K, v: V) { const s = m.get(k); if (s) s.add(v); else m.set(k, new Set([v])); }
function del<K, V>(m: Map<K, Set<V>>, k: K, v: V) { const s = m.get(k); if (!s) return; s.delete(v); if (!s.size) m.delete(k); }
