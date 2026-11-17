// Fuzzy title matching on SQLite. Every note name and alias, folded to a fuzzy key, is a row of
// fuzzy_name; triggers cut each key into trigrams (fuzzy_tri) and keep a count of keys per
// trigram (fuzzy_gram). A page title's uncommon trigrams pull the keys that share the most of
// them, and core/fuzzy.ts decides which of those are real matches.
//
// Not FTS5: an FTS5 trigram table answers the same question with an OR of every trigram, and in
// the wasm build that took 15 to 35 ms a title at 20,000 notes against 2 to 3 ms for this.
// (FTS5 trigram stays the right tool for substring search: LIKE '%text%'.)
//
// Runs in the indexer worker on the vault's database (src/sql/db.ts): the migration is a step of
// MIGRATIONS (src/sql/schema.ts), and SqlIndex keeps the table in step through its file listener
// (attach()). Rows are keyed by the note's id in `files`.
import { fuzzyKey, judge, FUZZY_MIN_LEN, type FuzzyVerdict } from '../core/fuzzy.ts';

/** The parts of an oo1.DB and oo1.Stmt this module uses. */
export interface Stmt { bind(values: unknown[]): Stmt; stepReset(): Stmt; finalize(): unknown }
export interface Db {
  exec(sql: string | { sql: string; bind?: unknown[] }): unknown;
  selectArrays(sql: string, bind?: unknown[]): unknown[][];
  selectValue(sql: string, bind?: unknown[]): unknown;
  prepare(sql: string): Stmt;
}

export const NAME = 0, ALIAS = 1;
/** How many keys, sharing the most trigrams with the title, judge() looks at. */
const POOL = 50;
/** Trigrams found in more than this share of keys say little and cost the most: left out of
 *  the lookup, unless that would leave fewer than 3. */
const COMMON_FRAC = 0.05, COMMON_MIN = 200;

// The trigrams of key `z` (SQLite's substr counts characters, as core/fuzzy.ts trigrams() does).
const grams = (z: string) => `WITH RECURSIVE i(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM i WHERE n < length(${z}) - 2)
  SELECT DISTINCT substr(${z}, n, 3) AS g FROM i WHERE length(${z}) >= 3`;

const GRAM_TRIGGER = `CREATE TRIGGER fuzzy_tri_ai AFTER INSERT ON fuzzy_tri BEGIN
      INSERT INTO fuzzy_gram(g, n) VALUES (new.g, 1) ON CONFLICT(g) DO UPDATE SET n = n + 1;
    END;`;

export function fuzzyMigration(db: { exec(sql: string): unknown }) {
  db.exec(`
    CREATE TABLE fuzzy_name(id INTEGER PRIMARY KEY, note INTEGER NOT NULL, kind INTEGER NOT NULL, z TEXT NOT NULL);
    CREATE INDEX fuzzy_name_note ON fuzzy_name(note);
    CREATE TABLE fuzzy_tri(g TEXT NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (g, id)) WITHOUT ROWID;
    CREATE TABLE fuzzy_gram(g TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TRIGGER fuzzy_name_ai AFTER INSERT ON fuzzy_name BEGIN
      INSERT INTO fuzzy_tri(g, id) SELECT g, new.id FROM (${grams('new.z')});
    END;
    CREATE TRIGGER fuzzy_name_ad AFTER DELETE ON fuzzy_name BEGIN
      DELETE FROM fuzzy_tri WHERE id = old.id AND g IN (${grams('old.z')});
    END;
    ${GRAM_TRIGGER}
    CREATE TRIGGER fuzzy_tri_ad AFTER DELETE ON fuzzy_tri BEGIN
      UPDATE fuzzy_gram SET n = n - 1 WHERE g = old.g;
      DELETE FROM fuzzy_gram WHERE g = old.g AND n <= 0;
    END;
  `);
}

export interface FuzzyHit extends FuzzyVerdict { path: string; kind: typeof NAME | typeof ALIAS; key: string }

/** What attach() needs of the index (SqlIndex). */
export interface Indexed { db: Db; listeners: ((path: string, kind: 'add' | 'remove' | 'update') => void)[]; note(path: string): { aliases: readonly string[] } | undefined }

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');

function keysOf(path: string, aliases: readonly string[]): Map<string, number> {
  const keys = new Map<string, number>();
  if (!/\.md$/i.test(path)) return keys;
  const add = (s: string, kind: number) => { const z = fuzzyKey(s); if (z && !keys.has(z)) keys.set(z, kind); };
  add(baseName(path), NAME);
  for (const a of aliases) add(a, ALIAS);
  return keys;
}

export class FuzzyTitles {
  db: Db;
  private ins: Stmt;
  private del: Stmt;
  constructor(db: Db) {
    this.db = db;
    this.ins = db.prepare('INSERT INTO fuzzy_name(note, kind, z) VALUES (?, ?, ?)');
    this.del = db.prepare('DELETE FROM fuzzy_name WHERE note = ?');
  }
  close() { this.ins.finalize(); this.del.finalize(); }

  /** Keep the table in step with an index: a note's keys are written in the same transaction as
   *  the note. 'remove' comes before the note's rows go, a move is a remove and then an add. */
  static attach(idx: Indexed): FuzzyTitles {
    const f = new FuzzyTitles(idx.db);
    idx.listeners.push((path, kind) => {
      if (!/\.md$/i.test(path)) return;
      const id = Number(idx.db.selectValue('SELECT id FROM files WHERE path = ?', [path]));
      if (!id) return;
      if (kind === 'remove') f.remove(id);
      else f.put(id, path, idx.note(path)?.aliases ?? [], kind === 'add');
    });
    return f;
  }

  /** Replace the keys of one note (by its id): its file name and its aliases. Run it inside a
   *  write transaction: on its own each call is a transaction, about half a millisecond. isNew: the
   *  note has no rows yet (a new file, or the second half of a move). */
  put(note: number, path: string, aliases: readonly string[] = [], isNew = false) {
    const keys = keysOf(path, aliases);
    if (isNew) { for (const [z, kind] of keys) this.ins.bind([note, kind, z]).stepReset(); return; }
    // A note whose name and aliases didn't change (an edit, a Rescan) keeps its rows: one lookup
    // instead of rewriting its trigrams.
    const had = this.db.selectArrays('SELECT z, kind FROM fuzzy_name WHERE note = ?', [note]) as [string, number][];
    if (had.length === keys.size && had.every(([z, kind]) => keys.get(z) === kind)) return;
    if (had.length) this.remove(note);
    for (const [z, kind] of keys) this.ins.bind([note, kind, z]).stepReset();
  }
  remove(note: number) {
    this.del.bind([note]).stepReset();
  }

  /** Fill the tables from scratch: a quarter faster than put() per note, because the trigram
   *  counts are made in one pass at the end. */
  build(notes: Iterable<{ id: number; path: string; aliases: readonly string[] }>) {
    const db = this.db;
    db.exec('SAVEPOINT fuzzy_build');
    try {
      db.exec('DELETE FROM fuzzy_name; DELETE FROM fuzzy_tri; DELETE FROM fuzzy_gram; DROP TRIGGER fuzzy_tri_ai;');
      for (const n of notes) for (const [z, kind] of keysOf(n.path, n.aliases)) this.ins.bind([n.id, kind, z]).stepReset();
      db.exec(`INSERT INTO fuzzy_gram(g, n) SELECT g, count(*) FROM fuzzy_tri GROUP BY g; ${GRAM_TRIGGER}`);
      db.exec('RELEASE fuzzy_build');
    } catch (e) {
      db.exec('ROLLBACK TO fuzzy_build; RELEASE fuzzy_build');
      throw e;
    }
  }

  /** Notes whose name or alias is a fuzzy match for a page title, best first, one per note. */
  match(title: string, limit = 10): FuzzyHit[] {
    const z = fuzzyKey(title);
    if (Array.from(z).length < FUZZY_MIN_LEN) return [];
    const total = Number(this.db.selectValue('SELECT count(*) FROM fuzzy_name')) || 0;
    const cap = Math.max(COMMON_MIN, total * COMMON_FRAC);
    // The title's trigrams that some key has, rarest first; the common ones dropped if enough remain.
    const known = this.db.selectArrays(`SELECT g, n FROM fuzzy_gram WHERE g IN (${grams('?1')}) ORDER BY n`, [z]) as [string, number][];
    let use = known.filter(([, n]) => n <= cap);
    if (use.length < 3) use = known;
    if (!use.length) return [];
    // A key must share at least 30% of them (2 at least, when there are 2).
    const need = Math.max(Math.min(2, use.length), Math.ceil(use.length * 0.3));
    // Ties go to keys closest in length: "owing" is in "knowing", "showing", "growing" ...
    const rows = this.db.selectArrays(
      `SELECT f.path, n.kind, n.z FROM (
         SELECT id, count(*) AS c FROM fuzzy_tri WHERE g IN (${use.map(() => '?').join(',')})
         GROUP BY id HAVING c >= ?
       ) t JOIN fuzzy_name n ON n.id = t.id JOIN files f ON f.id = n.note
       ORDER BY t.c DESC, abs(length(n.z) - length(?)) LIMIT ${POOL}`, [...use.map(([g]) => g), need, z]);
    const best = new Map<string, FuzzyHit>();
    for (const [path, kind, key] of rows as [string, number, string][]) {
      const v = judge(z, key);
      if (!v) continue;
      const prev = best.get(path);
      if (!prev || v.score > prev.score) best.set(path, { path, kind: kind as 0 | 1, key, ...v });
    }
    return [...best.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
  }
}
