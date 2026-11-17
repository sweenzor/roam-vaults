// Roam page title -> vault associations. No Node APIs.
import { VaultIndex, nfcLower, linkKey, fileKeyPath } from './vault-index.ts';
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
  src: string; line: number; embed: boolean;
  resolvedTo: string | null;      // null => unresolved link (only exists as text in the vault)
  via: 'backlink' | 'unresolved' | 'daily-unresolved';
}
export interface Associations { title: string; notes: NoteMatch[]; links: LinkMatch[]; tagged: { path: string; tag: string }[] }

export interface MatcherOptions {
  dailyFormats: string[];
  /** Match titles with the characters file names can't have removed. On unless set to false. */
  sanitized?: boolean;
  loose?: boolean;
  nsSeparators?: string[];
}

const ILLEGAL = /[\\/:*?"<>|#^\[\]]/g;           // illegal in Obsidian file names / link targets
export const sanitizedKey = (s: string) => nfcLower(s).replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim();
export const looseKey = (s: string) => nfcLower(s).replace(/[^\p{L}\p{N}]+/gu, '');

export class RoamMatcher {
  idx: VaultIndex;
  opts: MatcherOptions;
  formats: DateFormat[];
  nsSeps: string[];
  private listener: (p: string, kind: string) => void;

  constructor(idx: VaultIndex, opts: MatcherOptions) {
    this.idx = idx; this.opts = opts;
    this.formats = opts.dailyFormats.map(compileFormat);
    this.nsSeps = opts.nsSeparators ?? ['-', '_', ' - ', '∕', '／', '.', ' '];
    // The keys live in the index, so a store kept across starts has them already.
    const settings = JSON.stringify([opts.dailyFormats, opts.sanitized !== false, !!opts.loose]);
    if (!idx.keysMadeWith(settings)) for (const p of [...idx.notePaths()]) this.addPath(p);
    idx.listeners.push(this.listener = (p, kind) => {
      if (kind === 'add') this.addPath(p);
      else if (kind === 'remove') this.removePath(p);
    });
  }
  /** Stop following the index (it outlives this matcher). */
  detach() { const i = this.idx.listeners.indexOf(this.listener); if (i >= 0) this.idx.listeners.splice(i, 1); }
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
    if (this.opts.sanitized !== false) this.idx.addKey('s:' + k.s, p);
    if (this.opts.loose) this.idx.addKey('l:' + k.l, p);
    for (const iso of new Set(k.isos)) this.idx.addKey('d:' + iso, p);
  }
  private removePath(p: string) {
    if (!/\.md$/i.test(p)) return;
    const k = this.keysFor(p);
    if (this.opts.sanitized !== false) this.idx.removeKey('s:' + k.s, p);
    if (this.opts.loose) this.idx.removeKey('l:' + k.l, p);
    for (const iso of new Set(k.isos)) this.idx.removeKey('d:' + iso, p);
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
    for (const p of idx.aliasPaths(nfcLower(t))) put(p, 'alias');
    // (e) daily notes
    const iso = roamDailyToIso(t);
    if (iso) for (const p of idx.keyPaths('d:' + iso)) put(p, 'daily');
    // (f) namespace flattened into a single file name
    if (t.includes('/')) for (const sep of this.nsSeps) {
      for (const p of idx.pathsNamed(nfcLower(t.split('/').join(sep)))) if (/\.md$/i.test(p)) put(p, 'ns-flat');
    }
    // sanitized (illegal chars) tier
    if (this.opts.sanitized !== false) for (const p of idx.keyPaths('s:' + sanitizedKey(t))) put(p, 'sanitized');
    if (this.opts.loose) for (const p of idx.keyPaths('l:' + looseKey(t))) put(p, 'loose');

    // (d) notes that link to it: backlinks of every matched note + unresolved links by text
    const links: LinkMatch[] = [];
    for (const h of idx.backlinks(notes.keys())) links.push({ src: h.src, line: h.line, embed: h.embed, resolvedTo: h.resolved, via: 'backlink' });
    const keys = new Set<string>();
    const byText = (key: string, via: LinkMatch['via']) => {
      if (keys.has(key)) return;
      keys.add(key);
      for (const h of idx.unresolved(key)) links.push({ src: h.src, line: h.line, embed: h.embed, resolvedTo: null, via });
    };
    byText(linkKey(t), 'unresolved');
    if (iso) for (const f of this.opts.dailyFormats) byText(linkKey(formatIso(iso, f)), 'daily-unresolved');

    // tags: Roam treats #tag and [[tag]] as the same page
    const tagged: { path: string; tag: string }[] = [];
    const tk = nfcLower(t);
    const tagVariants = t.includes(' ') ? [tk, tk.replace(/ /g, '-'), tk.replace(/ /g, '_')] : [tk];
    for (const v of tagVariants) for (const p of idx.tagPaths(v)) tagged.push({ path: p, tag: v });

    return { title, notes: [...notes].map(([path, how]) => ({ path, how })), links, tagged };
  }
}

