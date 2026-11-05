// Ranked counterpart matching: Roam page title -> vault notes, each with a confidence
// score in [0, 1], a band, the evidence behind it and an ambiguity flag. No Node APIs.
//
// RoamMatcher (matcher.ts) answers "which notes match, and by which rule". This module
// answers "how sure are we, and which one first", so the UI can auto-link strong matches,
// show medium ones as likely, and keep weak ones as suggestions (FEASIBILITY.md §4–5).
//
// Scoring
// -------
// Every rule ("signal") that connects the title to a note has a fixed base score. A note's
// score is its best signal's score after penalties; every signal that fired is kept in
// `reasons`. Bases are ordered so that a less lossy normalization always outranks a more
// lossy one:
//
//   exact       1.00  basename === title (NFC)
//   case        0.95  basename equal ignoring case (Obsidian resolves links this way)
//   path        0.95  "A/B" == whole vault path A/B.md   (0.90 when it is only a suffix …/A/B.md)
//   daily       0.95  Roam daily title == vault daily note in a configured format
//   title       0.93  frontmatter `title:` (OKF, many publishing setups); 0.92 ignoring case
//   alias       0.93  frontmatter `aliases:`; 0.92 ignoring case
//   ns-encoded  0.90  "A/B" == Logseq's A___B.md or A%2FB.md
//   sanitized   0.80  filename-illegal chars removed:  "What is X?" == What is X.md
//   folded      0.75  + diacritics, curly quotes, dash variants, "&"/"and":  "Cafe" == Café.md
//   decorated   0.68  + leading/trailing emoji and symbols, trailing . , ; ! …, Johnny.Decimal /
//                     Zettel-ID prefixes:
//                     "Plugins" == 🗂️ Plugins.md, "Budget" == 12.04 Budget.md
//   ns-flat     0.60  "A/B" == A-B.md, A_B.md, A∕B.md, "A - B.md" …
//   loose       0.55  only letters and digits compared:  "Note-taking" == Notetaking.md
//   fuzzy       0.30 + 0.25·(sim − 0.8)/0.2, i.e. 0.30–0.55. sim is the better of
//               optimal-string-alignment similarity (typos, transpositions) and token-set
//               equality (word order: "Scott, Ridley" == Ridley Scott.md). Needs sim ≥ 0.8,
//               ≥ 5 characters, identical digit sequences ("Q3 plan" never fuzzes to "Q4 plan"),
//               the same word count, and at most 1 edit per word (2 for words of 10+ characters),
//               so "Internal links" never fuzzes to external-links.md.
//               Only tried when no other signal reached medium. Candidates come from a trigram
//               index, ignoring trigrams found in more than max(200, 2% of notes) notes.
//
// Penalties
//   - Title contains nested links ("[[Book]] by [[Author]]"): capped at 0.60. The filename can
//     only be a lossy rendering of it.
//   - Lossy rules (sanitized and below) are skipped when the normalized key is < 3 characters,
//     so "C#" does not become C.md and "?!" matches nothing.
//
// Bands: strong ≥ 0.85 (treat as the counterpart), medium ≥ 0.60 (likely, show with badge),
// weak ≥ minScore (default 0.30; suggestions only).
//
// Ambiguity: when two or more notes score less than 0.05 below the best and the best is at least
// medium, all of them are flagged `ambiguous`. Ties are ordered like the resolver: exact-case
// basename, shallower path, shorter path, then lexicographic. The UI should show every
// ambiguous candidate instead of silently picking one.
import { VaultIndex, nfcLower, fileKeyPath } from './vault-index.ts';
import { compileFormat, parseWithFormat, roamDailyToIso, type DateFormat } from './dates.ts';

export type Signal =
  | 'exact' | 'case' | 'path' | 'daily' | 'title' | 'alias' | 'ns-encoded'
  | 'sanitized' | 'folded' | 'decorated' | 'ns-flat' | 'loose' | 'fuzzy';
export type Band = 'strong' | 'medium' | 'weak';

export interface Reason { signal: Signal; score: number; detail?: string }
export interface RankedNote { path: string; score: number; band: Band; signal: Signal; reasons: Reason[]; ambiguous: boolean }

export interface RankerOptions {
  dailyFormats?: string[];
  nsSeparators?: string[];  // separators tried for the ns-flat signal
  fuzzy?: boolean;          // build the trigram index and emit fuzzy suggestions (default true)
}
export interface RankQuery { minScore?: number; limit?: number }

export const BASE: Record<Signal, number> = {
  exact: 1, case: 0.95, path: 0.95, daily: 0.95, title: 0.93, alias: 0.93, 'ns-encoded': 0.9,
  sanitized: 0.8, folded: 0.75, decorated: 0.68, 'ns-flat': 0.6, loose: 0.55, fuzzy: 0.55,
};
export const STRONG = 0.85, MEDIUM = 0.6, AMBIGUITY_GAP = 0.05;
const NESTED_CAP = 0.6, FUZZY_MIN_SIM = 0.8, FUZZY_MIN_LEN = 5, FUZZY_POOL = 50, MIN_LOSSY_LEN = 3;
const FUZZY_COMMON_MIN = 200, FUZZY_COMMON_FRAC = 0.02;

// ---------- normalization ----------
const ILLEGAL = /[\\/:*?"<>|#^\[\]]/g;
const ws = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Filename-illegal characters removed. */
export const sanitizeKey = (s: string) => ws(nfcLower(s).replace(ILLEGAL, ' '));
/** sanitizeKey plus diacritics, compatibility forms (fullwidth, ligatures), quotes, dashes, "&". */
export function foldKey(s: string): string {
  const t = s.normalize('NFKD').replace(/\p{M}+/gu, '').normalize('NFC').toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'").replace(/[“”„‟″]/g, '"').replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s*&\s*/g, ' and ');
  return ws(t.replace(ILLEGAL, ' '));
}
const DECOR = /^[\p{Extended_Pictographic}\p{S}\p{P}️‍\s]+|[\p{Extended_Pictographic}\p{S}️‍\s.,;!…]+$/gu;
const PREFIX = /^(?:\d{2}\.\d{2}|\d{12,14})\s+(?:-\s+)?/; // Johnny.Decimal "12.04 ", Zettel ID "202611051230 "
/** foldKey with decoration removed: leading/trailing emoji and symbols, ID prefixes. */
export const decorKey = (s: string) => foldKey(s.normalize('NFC').replace(PREFIX, '').replace(DECOR, ''));
/** Letters and digits only. */
export const looseKey = (s: string) => foldKey(s).replace(/[^\p{L}\p{N}]+/gu, '');
/** Words of letters and digits, single-space separated. Used for fuzzy scoring. */
export const fuzzyKey = (s: string) => ws(foldKey(decorKey(s)).replace(/[^\p{L}\p{N}]+/gu, ' '));
const digits = (s: string) => (s.match(/\d+/g) ?? []).join(',');

// ---------- similarity ----------
/** Optimal string alignment distance (Levenshtein + adjacent transpositions), on code points. */
export function osaDistance(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b);
  const n = x.length, m = y.length;
  if (!n) return m; if (!m) return n;
  let pp = new Array<number>(m + 1).fill(0), p = Array.from({ length: m + 1 }, (_, j) => j), c = new Array<number>(m + 1);
  for (let i = 1; i <= n; i++) {
    c[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let v = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) v = Math.min(v, pp[j - 2] + 1);
      c[j] = v;
    }
    [pp, p, c] = [p, c, pp];
  }
  return p[m];
}
/** Edits a single word may differ by and still count as a typo: 1, or 2 from 10 code points. */
const wordBudget = (w: string) => (Array.from(w).length >= 10 ? 2 : 1);
/**
 * Fuzzy keys must have the same number of words, and in original or sorted order every word
 * pair must be within its typo budget. This keeps "internal links" away from "external links"
 * (one word, two edits) while "recieve window" ~ "receive window" passes.
 */
export function wordsAlign(a: string, b: string): boolean {
  const x = a.split(' '), y = b.split(' ');
  if (x.length !== y.length) return false;
  const ok = (p: string[], q: string[]) => p.every((w, i) => w === q[i] || osaDistance(w, q[i]) <= wordBudget(w));
  return ok(x, y) || ok(x.slice().sort(), y.slice().sort());
}
/** Similarity in [0, 1] of two fuzzy keys. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const len = Math.max(Array.from(a).length, Array.from(b).length);
  const edit = 1 - osaDistance(a, b) / len;
  const ta = a.split(' ').sort().join(' '), tb = b.split(' ').sort().join(' ');
  const reorder = ta === tb ? 0.95 : 1 - osaDistance(ta, tb) / len;
  return Math.max(edit, reorder);
}
const trigrams = (k: string) => { const s = ` ${k} `, out = new Set<string>(); for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3)); return out; };

// ---------- ranker ----------
interface Keys { s: string; f: string; d: string; l: string; z: string; isos: string[]; title: string | null }

export class NoteRanker {
  idx: VaultIndex;
  formats: DateFormat[];
  nsSeps: string[];
  fuzzy: boolean;
  private keys = new Map<string, Keys>();
  private maps = { s: new Map<string, Set<string>>(), f: new Map<string, Set<string>>(), d: new Map<string, Set<string>>(), l: new Map<string, Set<string>>(), daily: new Map<string, Set<string>>(), title: new Map<string, Set<string>>() };
  private tri = new Map<string, Set<string>>();

  constructor(idx: VaultIndex, opts: RankerOptions = {}) {
    this.idx = idx;
    this.formats = (opts.dailyFormats ?? ['YYYY-MM-DD']).map(compileFormat);
    this.nsSeps = opts.nsSeparators ?? ['-', '_', ' - ', '∕', '／', '.', ' '];
    this.fuzzy = opts.fuzzy ?? true;
    for (const p of idx.notes.keys()) this.addPath(p);
    idx.listeners.push((p, kind) => {
      if (kind !== 'add') this.removePath(p);
      if (kind !== 'remove') this.addPath(p);
    });
  }

  private addPath(p: string) {
    if (!/\.md$/i.test(p)) return;
    const base = p.slice(p.lastIndexOf('/') + 1, -3);
    const t = this.idx.notes.get(p)?.props?.title;
    const k: Keys = {
      s: sanitizeKey(base), f: foldKey(base), d: decorKey(base), l: looseKey(base), z: fuzzyKey(base),
      isos: this.formats.map((f) => parseWithFormat(p.replace(/\.md$/i, ''), f)).filter((x): x is string => !!x),
      title: typeof t === 'string' && t.trim() ? t.normalize('NFC').trim() : null,
    };
    this.keys.set(p, k);
    add(this.maps.s, k.s, p); add(this.maps.f, k.f, p); add(this.maps.d, k.d, p); add(this.maps.l, k.l, p);
    for (const iso of k.isos) add(this.maps.daily, iso, p);
    if (k.title) add(this.maps.title, nfcLower(k.title), p);
    if (this.fuzzy && k.z) for (const g of trigrams(k.z)) add(this.tri, g, p);
  }
  private removePath(p: string) {
    const k = this.keys.get(p);
    if (!k) return;
    this.keys.delete(p);
    del(this.maps.s, k.s, p); del(this.maps.f, k.f, p); del(this.maps.d, k.d, p); del(this.maps.l, k.l, p);
    for (const iso of k.isos) del(this.maps.daily, iso, p);
    if (k.title) del(this.maps.title, nfcLower(k.title), p);
    if (this.fuzzy && k.z) for (const g of trigrams(k.z)) del(this.tri, g, p);
  }

  /** Vault notes that could be the counterpart of Roam page `title`, best first. */
  rank(title: string, q: RankQuery = {}): RankedNote[] {
    const minScore = q.minScore ?? 0.3;
    const t = title.normalize('NFC').trim();
    if (!t) return [];
    const hits = new Map<string, Reason[]>();
    const hit = (p: string, signal: Signal, score = BASE[signal], detail?: string) => {
      if (!/\.md$/i.test(p)) return;
      const r = hits.get(p);
      const reason: Reason = detail ? { signal, score, detail } : { signal, score };
      if (!r) hits.set(p, [reason]); else if (!r.some((x) => x.signal === signal)) r.push(reason);
    };
    const tl = nfcLower(t);
    const nested = t.includes('[[');
    const isNs = t.includes('/') && !nested;
    const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1, -3);

    // name, case and namespace path
    if (isNs) {
      const key = tl.replace(/^\/+/, '');
      for (const p of this.idx.byName.get(key.slice(key.lastIndexOf('/') + 1)) ?? []) {
        const kp = fileKeyPath(p);
        const full = kp === key, suffix = kp.endsWith('/' + key);
        if (!full && !suffix) continue;
        const exactCase = p.slice(0, -3).endsWith(t);
        hit(p, 'path', (full ? BASE.path : 0.9) - (exactCase ? 0 : 0.03), full ? undefined : 'suffix');
      }
      for (const enc of ['___', '%2f']) for (const p of this.idx.byName.get(key.split('/').join(enc)) ?? []) hit(p, 'ns-encoded');
      for (const sep of this.nsSeps) for (const p of this.idx.byName.get(key.split('/').join(sep)) ?? []) hit(p, 'ns-flat', BASE['ns-flat'], JSON.stringify(sep));
    } else if (!nested) {
      for (const p of this.idx.byName.get(tl) ?? []) hit(p, baseOf(p) === t ? 'exact' : 'case');
    }

    // aliases and frontmatter titles
    for (const p of this.idx.aliasIdx.get(tl) ?? []) {
      const exact = this.idx.notes.get(p)?.aliases.some((a) => a.normalize('NFC') === t);
      hit(p, 'alias', exact ? BASE.alias : 0.92);
    }
    for (const p of this.maps.title.get(tl) ?? []) hit(p, 'title', this.keys.get(p)!.title === t ? BASE.title : 0.92);

    // daily notes
    const iso = roamDailyToIso(t);
    if (iso) for (const p of this.maps.daily.get(iso) ?? []) hit(p, 'daily', BASE.daily, iso);

    // lossy normalizations (namespace titles only reach these through ns-flat above)
    if (!isNs) {
      const lossy: [Signal, Map<string, Set<string>>, string][] = [
        ['sanitized', this.maps.s, sanitizeKey(t)], ['folded', this.maps.f, foldKey(t)],
        ['decorated', this.maps.d, decorKey(t)], ['loose', this.maps.l, looseKey(t)],
      ];
      for (const [sig, map, key] of lossy) {
        if (looseKey(key).length < MIN_LOSSY_LEN) continue;
        for (const p of map.get(key) ?? []) hit(p, sig);
      }
      // fuzzy is a fallback: only when nothing better than a weak match was found
      if (this.fuzzy && ![...hits.values()].some((rs) => rs.some((x) => x.score >= MEDIUM))) this.fuzzyHits(t, hit);
    }

    // score, band, sort
    const out: RankedNote[] = [];
    for (const [path, reasons] of hits) {
      reasons.sort((a, b) => b.score - a.score);
      let score = reasons[0].score;
      if (nested) score = Math.min(score, NESTED_CAP);
      score = Math.round(score * 1000) / 1000;
      if (score < minScore) continue;
      out.push({ path, score, band: band(score), signal: reasons[0].signal, reasons, ambiguous: false });
    }
    out.sort((a, b) => b.score - a.score || tieBreak(a.path, b.path, t));
    if (out.length > 1 && out[0].score >= MEDIUM && out[0].score - out[1].score < AMBIGUITY_GAP - 1e-9) {
      for (const r of out) if (out[0].score - r.score < AMBIGUITY_GAP - 1e-9) r.ambiguous = true;
    }
    return q.limit ? out.slice(0, q.limit) : out;
  }

  private fuzzyHits(t: string, hit: (p: string, s: Signal, score?: number, detail?: string) => void) {
    const z = fuzzyKey(t);
    if (Array.from(z).length < FUZZY_MIN_LEN) return;
    const qd = digits(z), qt = trigrams(z);
    // Trigrams shared by many notes (" th", "ing") say little and dominate the cost: skip them.
    const cap = Math.max(FUZZY_COMMON_MIN, this.keys.size * FUZZY_COMMON_FRAC);
    const counts = new Map<string, number>();
    let used = 0;
    for (const g of qt) {
      const ps = this.tri.get(g);
      if (!ps || ps.size > cap) continue;
      used++;
      for (const p of ps) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    const need = Math.max(Math.min(2, used), Math.ceil(used * 0.3));
    const pool = [...counts].filter(([, c]) => c >= need).sort((a, b) => b[1] - a[1]).slice(0, FUZZY_POOL);
    for (const [p] of pool) {
      const k = this.keys.get(p)!;
      if (digits(k.z) !== qd || !wordsAlign(z, k.z)) continue;
      const sim = similarity(z, k.z);
      if (sim < FUZZY_MIN_SIM || sim === 1 && k.l === looseKey(t)) continue; // sim 1 is the loose tier's job
      const score = 0.3 + (BASE.fuzzy - 0.3) * Math.min(1, (sim - FUZZY_MIN_SIM) / (1 - FUZZY_MIN_SIM));
      hit(p, 'fuzzy', Math.round(score * 1000) / 1000, `sim=${sim.toFixed(2)}`);
    }
  }
}

export const band = (score: number): Band => (score >= STRONG ? 'strong' : score >= MEDIUM ? 'medium' : 'weak');

function tieBreak(a: string, b: string, title: string): number {
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const ca = base(a) === title ? 0 : 1, cb = base(b) === title ? 0 : 1;
  if (ca !== cb) return ca - cb;
  const da = a.split('/').length, db = b.split('/').length;
  if (da !== db) return da - db;
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function add<K, V>(m: Map<K, Set<V>>, k: K, v: V) { const s = m.get(k); if (s) s.add(v); else m.set(k, new Set([v])); }
function del<K, V>(m: Map<K, Set<V>>, k: K, v: V) { const s = m.get(k); if (!s) return; s.delete(v); if (!s.size) m.delete(k); }
