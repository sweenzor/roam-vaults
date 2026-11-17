// Fuzzy page-title matching over a VaultIndex: which notes have a name or alias close to a Roam
// page title (typos, swapped letters, plurals, word order). Scoring is core/fuzzy.ts. No Node APIs.
//
// A fuzzy match must start every word with the same letter (core/fuzzy.ts wordsAlign), so notes
// are kept in buckets by the first letters of their words, sorted: "Receive Window" and "Window
// Receive" both go under "rw". A title looks in its own bucket (and, for a swap of a word's first
// two letters, in the bucket that swap gives) and judges what is there. Nothing but paths is kept:
// a note's key is made again from its name when a page asks, which costs well under a millisecond
// and saves holding a string per note.
import type { VaultIndex } from './vault-index.ts';
import { fuzzyKey, judge, FUZZY_MIN_LEN, type FuzzyVerdict } from './fuzzy.ts';

export const NAME = 0, ALIAS = 1;
export interface FuzzyHit extends FuzzyVerdict { path: string; kind: typeof NAME | typeof ALIAS }

const MD = /\.md$/i;
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(MD, '');
/** First code point of each word, sorted. */
function bucketOf(z: string): string | null {
  if (!z) return null;
  return z.split(' ').map((w) => String.fromCodePoint(w.codePointAt(0)!)).sort().join('');
}
/** The buckets a title looks in: its own, and one for each word whose first two letters are
 *  swapped. None for a title too short to match (a short note name can still match a longer
 *  title: "Jests" ~ Jest.md). */
function bucketsFor(z: string): string[] {
  if (Array.from(z).length < FUZZY_MIN_LEN) return [];
  const own = bucketOf(z);
  if (own === null) return [];
  const out = new Set([own]);
  const words = z.split(' ');
  words.forEach((w, i) => {
    const cp = Array.from(w);
    if (cp.length < 2 || cp[0] === cp[1]) return;
    const swapped = words.slice();
    swapped[i] = cp[1] + cp[0] + cp.slice(2).join('');
    out.add(bucketOf(swapped.join(' '))!);
  });
  return [...out];
}

export class FuzzyIndex {
  idx: VaultIndex;
  private names = new Map<string, string[]>();     // bucket -> note paths, by file name
  private aliases = new Map<string, string[]>();   // bucket -> note paths, by an alias
  /** The alias buckets each note is in, to take it out again after its aliases change. */
  private aliasAt = new Map<string, string[]>();
  private detachFn: () => void;

  constructor(idx: VaultIndex) {
    this.idx = idx;
    for (const p of idx.notes.keys()) this.add(p);
    const l = (p: string, kind: 'add' | 'remove' | 'update') => {
      if (kind !== 'add') this.remove(p);
      if (kind !== 'remove') this.add(p);
    };
    idx.listeners.push(l);
    this.detachFn = () => { const i = idx.listeners.indexOf(l); if (i >= 0) idx.listeners.splice(i, 1); };
  }
  detach() { this.detachFn(); }

  private add(p: string) {
    if (!MD.test(p)) return;
    const b = bucketOf(fuzzyKey(nameOf(p)));
    if (b !== null) push(this.names, b, p);
    const aliases = this.idx.notes.get(p)?.aliases ?? [];
    if (!aliases.length) return;
    const at = [...new Set(aliases.map((a) => bucketOf(fuzzyKey(a))).filter((x): x is string => x !== null))];
    for (const k of at) push(this.aliases, k, p);
    if (at.length) this.aliasAt.set(p, at);
  }
  private remove(p: string) {
    if (!MD.test(p)) return;
    const b = bucketOf(fuzzyKey(nameOf(p)));
    if (b !== null) pull(this.names, b, p);
    for (const k of this.aliasAt.get(p) ?? []) pull(this.aliases, k, p);
    this.aliasAt.delete(p);
  }

  /** Notes whose name or alias is a fuzzy match for a page title, best first, one per note. */
  match(title: string, limit = 10): FuzzyHit[] {
    const z = fuzzyKey(title);
    const best = new Map<string, FuzzyHit>();
    const consider = (path: string, key: string, kind: typeof NAME | typeof ALIAS) => {
      const v = judge(z, key);
      if (!v) return;
      const prev = best.get(path);
      if (!prev || v.score > prev.score) best.set(path, { path, kind, ...v });
    };
    for (const b of bucketsFor(z)) {
      for (const p of this.names.get(b) ?? []) consider(p, fuzzyKey(nameOf(p)), NAME);
      for (const p of this.aliases.get(b) ?? []) for (const a of this.idx.notes.get(p)?.aliases ?? []) consider(p, fuzzyKey(a), ALIAS);
    }
    return [...best.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
  }
}

function push(m: Map<string, string[]>, k: string, v: string) { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); }
function pull(m: Map<string, string[]>, k: string, v: string) {
  const l = m.get(k);
  if (!l) return;
  const i = l.indexOf(v);
  if (i >= 0) { l[i] = l[l.length - 1]; l.pop(); }
  if (!l.length) m.delete(k);
}
