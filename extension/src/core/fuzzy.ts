// Fuzzy matching of a Roam page title to vault note names: the scoring half. No Node APIs.
// Candidates come from core/fuzzy-index.ts; this module decides which of them are close enough
// and how close, and which letters differ (for display).
//
// Ported from the tabled ranker (old PR #1, spike/src/core/ranker.ts), keeping its guards:
//   - keys are folded (case, diacritics, fullwidth, curly quotes, dashes, "&") and reduced to
//     words of letters and digits, so "Café – Notes" and "cafe notes" are the same key;
//   - similarity is the better of optimal-string-alignment (typos, transpositions) and the same
//     on sorted words (word order: "Scott, Ridley" ~ "Ridley Scott");
//   - identical keys score 0.55, the top of the band (punctuation, case or diacritics only);
//   - a match needs similarity >= 0.8, a key of 5+ characters, the same digits ("Q3 Plan" never
//     matches "Q4 Plan"), the same number of words, and at most 1 edit per word (2 for words of
//     10+ characters), so "Internal links" never matches "External links", and the same first
//     letter in every word (new here: "Might" never matches "Eight").
// Scores map similarity 0.8..1 onto 0.30..0.55: always below every exact or rule-based tier.

export const FUZZY_MIN_SIM = 0.8;
export const FUZZY_MIN_LEN = 5;
export const FUZZY_LOW = 0.3, FUZZY_HIGH = 0.55;

const ILLEGAL = /[\\/:*?"<>|#^\[\]]/g;
const ws = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Lowercase; no diacritics, compatibility forms, curly quotes or dash variants; "&" -> "and". */
export function foldKey(s: string): string {
  const t = s.normalize('NFKD').replace(/\p{M}+/gu, '').normalize('NFC').toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'").replace(/[“”„‟″]/g, '"').replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s*&\s*/g, ' and ');
  return ws(t.replace(ILLEGAL, ' '));
}
const DECOR = /^[\p{Extended_Pictographic}\p{S}\p{P}️‍\s]+|[\p{Extended_Pictographic}\p{S}️‍\s.,;!…]+$/gu;
const PREFIX = /^(?:\d{2}\.\d{2}|\d{12,14})\s+(?:-\s+)?/; // Johnny.Decimal "12.04 ", Zettel ID "202611051230 "
/** Words of letters and digits, single-space separated, without decoration or ID prefixes. */
export function fuzzyKey(s: string): string {
  const d = s.normalize('NFC').replace(PREFIX, '').replace(DECOR, '');
  // An apostrophe inside a word joins it: "Don't" -> "dont", not two words.
  return ws(foldKey(d).replace(/(?<=\p{L})'(?=\p{L})/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' '));
}
const digits = (s: string) => (s.match(/\p{N}+/gu) ?? []).join(',');

/** Optimal string alignment distance (Levenshtein + adjacent transpositions), on code points. */
export function osaDistance(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b);
  const n = x.length, m = y.length;
  if (!n) return m;
  if (!m) return n;
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

const wordBudget = (w: string) => (Array.from(w).length >= 10 ? 2 : 1);
/** People rarely mistype the first letter of a word, and most pairs of real words one edit
 *  apart differ there ("might" / "eight", "recent" / "decent"): it must match, unless the
 *  first two letters are swapped. */
const sameStart = (w: string, v: string) => w[0] === v[0] || (w[0] === v[1] && w[1] === v[0]);
/** Same number of words, and in written or sorted order each word is within its typo budget. */
export function wordsAlign(a: string, b: string): boolean {
  const x = a.split(' '), y = b.split(' ');
  if (x.length !== y.length) return false;
  const ok = (p: string[], q: string[]) => p.every((w, i) => w === q[i] || sameStart(w, q[i]) && osaDistance(w, q[i]) <= wordBudget(w));
  return ok(x, y) || ok(x.slice().sort(), y.slice().sort());
}

/** Similarity in [0, 1] of two fuzzy keys. Same words in another order scores 0.95. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const len = Math.max(Array.from(a).length, Array.from(b).length);
  const edit = 1 - osaDistance(a, b) / len;
  const ta = a.split(' ').sort().join(' '), tb = b.split(' ').sort().join(' ');
  const reorder = ta === tb ? 0.95 : 1 - osaDistance(ta, tb) / len;
  return Math.max(edit, reorder);
}

export interface FuzzyVerdict { sim: number; score: number }

/** Is note name key `cand` a fuzzy match for title key `q` (both from fuzzyKey)? Identical keys
 *  score highest ("Dont Panic" ~ "Don't Panic.md"); notes an exact tier already found are the
 *  caller's to drop. */
export function judge(q: string, cand: string): FuzzyVerdict | null {
  if (Array.from(q).length < FUZZY_MIN_LEN) return null;
  if (q === cand) return { sim: 1, score: FUZZY_HIGH };
  if (digits(q) !== digits(cand) || !wordsAlign(q, cand)) return null;
  const sim = similarity(q, cand);
  if (sim < FUZZY_MIN_SIM) return null;
  const score = FUZZY_LOW + (FUZZY_HIGH - FUZZY_LOW) * Math.min(1, (sim - FUZZY_MIN_SIM) / (1 - FUZZY_MIN_SIM));
  return { sim: Math.round(sim * 1000) / 1000, score: Math.round(score * 1000) / 1000 };
}

// ---------- what differs, for display ----------
const foldChar = (c: string) => c.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
const isUnit = (c: string) => /[\p{L}\p{N}]/u.test(c);
interface Unit { c: string; at: number; len: number }
/** Letters and digits of a string, folded, with where each is in it, grouped into words. */
function wordsOf(s: string): Unit[][] {
  const words: Unit[][] = [];
  let cur: Unit[] = [], at = 0, prev = '';
  for (const ch of s) {
    // an apostrophe inside a word joins it, as in fuzzyKey
    if (isUnit(ch)) cur.push({ c: foldChar(ch), at, len: ch.length });
    else if (!((ch === "'" || ch === '’') && isUnit(prev))) { if (cur.length) words.push(cur); cur = []; }
    at += ch.length; prev = ch;
  }
  if (cur.length) words.push(cur);
  return words;
}
/** Optimal string alignment of a against b; the units of `a` that are not plain matches. */
function diffUnits(a: Unit[], b: Unit[]): { cost: number; marked: Unit[] } {
  const n = a.length, m = b.length;
  const d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const cost = a[i - 1].c === b[j - 1].c ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1].c === b[j - 2].c && a[i - 2].c === b[j - 1].c) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  const marked: Unit[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1].c === b[j - 1].c && d[i][j] === d[i - 1][j - 1]) { i--; j--; }
    else if (i > 1 && j > 1 && a[i - 1].c === b[j - 2].c && a[i - 2].c === b[j - 1].c && d[i][j] === d[i - 2][j - 2] + 1) { marked.push(a[i - 1], a[i - 2]); i -= 2; j -= 2; }
    else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) { marked.push(a[i - 1]); i--; j--; }
    else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { marked.push(a[i - 1]); i--; }
    else j--; // a letter of the page title that the name lacks: nothing in the name to mark
  }
  return { cost: d[n][m], marked };
}
/**
 * Where a note name differs from the page title it fuzzy-matched: [start, end) ranges of the
 * name (UTF-16), for letters that are changed, extra or swapped. Words are compared in order or,
 * if that is closer, in sorted order (a swapped word order is not marked). Case, accents and
 * punctuation don't count, as in matching.
 */
export function diffMarks(name: string, title: string): [number, number][] {
  const x = wordsOf(name), y = wordsOf(title);
  let marked: Unit[];
  if (x.length === y.length) {
    const pairUp = (p: Unit[][], q: Unit[][]) => p.map((w, k) => diffUnits(w, q[k]));
    const key = (w: Unit[]) => w.map((u) => u.c).join('');
    const sorted = (w: Unit[][]) => w.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const inOrder = pairUp(x, y), bySort = pairUp(sorted(x), sorted(y));
    const total = (r: { cost: number }[]) => r.reduce((s, z) => s + z.cost, 0);
    marked = (total(bySort) < total(inOrder) ? bySort : inOrder).flatMap((r) => r.marked);
  } else marked = diffUnits(x.flat(), y.flat()).marked;
  const out: [number, number][] = [];
  for (const u of marked.sort((a, b) => a.at - b.at)) {
    const last = out[out.length - 1];
    if (last && last[1] === u.at) last[1] = u.at + u.len; else out.push([u.at, u.at + u.len]);
  }
  return out;
}
