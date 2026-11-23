// The vault index's tables. Each entry is one step, applied once, in order, and counted in
// PRAGMA user_version: add a step at the end, never change one that has shipped.
//
// The database is a cache of what the vault's files say, so a step may also drop everything and
// let the next scan read the vault again.

import { fuzzyMigration } from './fuzzy.ts';

type Db = { exec(sql: string): unknown };

export const MIGRATIONS: ((db: Db) => void)[] = [
  (db) => db.exec(`
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
    -- Every file in the vault. name is the name key links are looked up by (lowercase file name,
    -- notes without ".md").
    CREATE TABLE files(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
    CREATE INDEX files_name ON files(name);
    -- The notes among them (same id), with the file's size and time when it was read. aliases and
    -- tags are JSON arrays as written; links is the note's links as JSON flat pairs, as in Note.
    CREATE TABLE notes(id INTEGER PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL,
      aliases TEXT NOT NULL, tags TEXT NOT NULL, links TEXT NOT NULL);
    -- For each note, the name keys its links are looked up by, once each, with those links (JSON
    -- flat pairs, as in Note). Links are resolved when a page asks, as in VaultIndex: this finds
    -- the links that may point at a file. Keyed by note, so a scan appends rows in order; only the
    -- small index by name takes inserts all over.
    CREATE TABLE link_names(note INTEGER NOT NULL, name TEXT NOT NULL, links TEXT NOT NULL,
      PRIMARY KEY(note, name)) WITHOUT ROWID;
    CREATE INDEX link_names_name ON link_names(name);
    -- Lookup keys per note: 0 alias, 1 tag (with its parent tags), 2 the matcher's keys.
    CREATE TABLE note_keys(kind INTEGER NOT NULL, key TEXT NOT NULL, note INTEGER NOT NULL,
      PRIMARY KEY(kind, key, note)) WITHOUT ROWID;
    CREATE INDEX note_keys_note ON note_keys(note);
  `),
  // Similar names (src/sql/fuzzy.ts). Notes already in the database have no rows there: start over.
  (db) => {
    fuzzyMigration(db);
    db.exec('DELETE FROM link_names; DELETE FROM note_keys; DELETE FROM notes; DELETE FROM files; DELETE FROM meta;');
  },
  // A note's title property is an alias, a log's days are links, and tags are read as Obsidian
  // reads them: what was read before is read again.
  (db) => db.exec('DELETE FROM fuzzy_name; DELETE FROM link_names; DELETE FROM note_keys; DELETE FROM notes; DELETE FROM files; DELETE FROM meta;'),  // 4: dates and paths to notes in properties are links now: read again.
  (db) => db.exec('DELETE FROM fuzzy_name; DELETE FROM link_names; DELETE FROM note_keys; DELETE FROM notes; DELETE FROM files; DELETE FROM meta;'),
  // 5: a note's OKF title and whether it is a bundle's root (JSON, as in Note; NULL for neither): read again.
  (db) => db.exec(`ALTER TABLE notes ADD COLUMN okf TEXT;
    DELETE FROM fuzzy_name; DELETE FROM link_names; DELETE FROM note_keys; DELETE FROM notes; DELETE FROM files; DELETE FROM meta;`),
  // 6: reference-style Markdown links are links now: read again.
  (db) => db.exec('DELETE FROM fuzzy_name; DELETE FROM link_names; DELETE FROM note_keys; DELETE FROM notes; DELETE FROM files; DELETE FROM meta;'),
];

/**
 * The indexes only lookups need, as the steps above made them. A scan into an empty database drops
 * them and makes them again at the end (SqlIndex.bulk): building one in a go takes far less than
 * keeping it up to date row by row.
 */
export const LOOKUP_INDEXES: [name: string, on: string][] = [
  ['files_name', 'files(name)'],
  ['link_names_name', 'link_names(name)'],
  ['note_keys_note', 'note_keys(note)'],
];

export function migrate(db: Db & { selectValue(sql: string): unknown }) {
  const at = Number(db.selectValue('PRAGMA user_version'));
  for (let v = at; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}
