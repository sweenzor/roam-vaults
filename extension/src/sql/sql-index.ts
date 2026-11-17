// The vault index kept in SQLite instead of in JavaScript maps: same lookups, same link resolution
// (VaultIndex.candidates and its Obsidian tie-break rules are inherited unchanged). The database is
// kept across starts, so it is also the parse cache: a note whose size and time match is not read
// again. Runs in the indexer worker.
import { VaultIndex, NONE, baseOf, fileKeyPath, aliasKeys, noteTagKeys } from '../core/vault-index.ts';
import type { Note } from '../core/types.ts';

const ALIAS = 0, TAG = 1, MATCHER = 2;
const WRITES_PER_COMMIT = 20000;

export class SqlIndex extends VaultIndex {
  override readonly inPlace = true;
  db: any;
  private stmts = new Map<string, any>();
  private inTx = false;
  private writes = 0;

  constructor(db: any) { super(); this.db = db; }

  // ---------- statements ----------
  private st(sql: string) {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, s = this.db.prepare(sql));
    return s;
  }
  private rows(sql: string, bind?: unknown[]): any[][] {
    const s = this.st(sql);
    try {
      if (bind) s.bind(bind);
      const out: any[][] = [];
      while (s.step()) out.push(s.get([]));
      return out;
    } finally { s.reset(true); }
  }
  private col(sql: string, bind?: unknown[]): any[] {
    const s = this.st(sql);
    try {
      if (bind) s.bind(bind);
      const out: any[] = [];
      while (s.step()) out.push(s.get(0));
      return out;
    } finally { s.reset(true); }
  }
  private one(sql: string, bind?: unknown[]): any[] | undefined {
    const s = this.st(sql);
    try { if (bind) s.bind(bind); return s.step() ? s.get([]) : undefined; } finally { s.reset(true); }
  }
  private run(sql: string, bind?: unknown[]) {
    const s = this.st(sql);
    try { if (bind) s.bind(bind); s.step(); } finally { s.reset(true); }
  }
  /** Writes go into a transaction, committed every few thousand writes and by flush(). */
  private write() {
    if (!this.inTx) { this.db.exec('BEGIN'); this.inTx = true; this.writes = 0; }
    if (++this.writes >= WRITES_PER_COMMIT) { this.db.exec('COMMIT'); this.inTx = false; }
  }
  override flush() { if (this.inTx) { this.db.exec('COMMIT'); this.inTx = false; } }
  close() {
    this.flush();
    for (const s of this.stmts.values()) s.finalize();
    this.stmts.clear();
    this.db.close();
  }

  private idOf(path: string): number | undefined {
    return this.one('SELECT id FROM files WHERE path = ?', [path])?.[0];
  }

  // ---------- lookups ----------
  override hasFile(path: string) { return this.idOf(path) !== undefined; }
  override nameOf(path: string): string | undefined { return this.one('SELECT name FROM files WHERE path = ?', [path])?.[0]; }
  /** Paths by name key, as recently looked up: resolving a page's links asks for the same names
   *  over and over. Cleared whenever a file comes, goes or moves; bounded. */
  private named = new Map<string, readonly string[]>();
  override pathsNamed(nameKey: string): readonly string[] {
    let out = this.named.get(nameKey);
    if (out) return out;
    const found = this.col('SELECT path FROM files WHERE name = ? ORDER BY id', [nameKey]);
    out = found.length ? found : NONE;
    if (this.named.size >= 4096) this.named.clear();
    this.named.set(nameKey, out);
    return out;
  }
  override eachLinker(name: string, fn: (src: string, target: string, where: number) => void) {
    for (const [src, json] of this.rows(
      'SELECT f.path, l.links FROM link_names l JOIN files f ON f.id = l.note WHERE l.name = ? ORDER BY l.note', [name])) {
      const links = JSON.parse(json);
      for (let i = 0; i < links.length; i += 2) fn(src, links[i], links[i + 1]);
    }
  }
  private linkName(target: string, src: string) { return baseOf(this.keyOf(target, src)); }
  /** A note's rows for link_names: name key, and its links as flat pairs. */
  private linksByName(links: (string | number)[], src: string): [string, (string | number)[]][] {
    const by = new Map<string, (string | number)[]>();
    for (let i = 0; i < links.length; i += 2) {
      const name = this.linkName(links[i] as string, src);
      const at = by.get(name);
      if (at) at.push(links[i], links[i + 1]); else by.set(name, [links[i], links[i + 1]]);
    }
    return [...by];
  }
  private addLinkNames(id: number, links: (string | number)[], src: string) {
    const rows = this.linksByName(links, src).map(([name, l]) => [name, JSON.stringify(l)]);
    if (rows.length) this.run('INSERT INTO link_names(note, name, links) SELECT ?, value ->> 0, value ->> 1 FROM json_each(?)', [id, JSON.stringify(rows)]);
  }
  private keyed(kind: number, key: string): readonly string[] {
    const out = this.col('SELECT f.path FROM note_keys k JOIN files f ON f.id = k.note WHERE k.kind = ? AND k.key = ? ORDER BY k.note', [kind, key]);
    return out.length ? out : NONE;
  }
  override aliasPaths(key: string) { return this.keyed(ALIAS, key); }
  override tagPaths(key: string) { return this.keyed(TAG, key); }
  override keyPaths(key: string) { return this.keyed(MATCHER, key); }
  override stampOf(path: string): { size: number; mtime: number } | undefined {
    const r = this.one('SELECT n.size, n.mtime FROM files f JOIN notes n ON n.id = f.id WHERE f.path = ?', [path]);
    return r && { size: r[0], mtime: r[1] };
  }
  override note(path: string): Note | undefined {
    const r = this.one('SELECT f.id, n.size, n.mtime, n.aliases, n.tags, n.links FROM files f JOIN notes n ON n.id = f.id WHERE f.path = ?', [path]);
    if (!r) return undefined;
    const aliases = JSON.parse(r[3]), tags = JSON.parse(r[4]), links = JSON.parse(r[5]);
    return { path, size: r[1], mtime: r[2], aliases: aliases.length ? aliases : NONE, tags: tags.length ? tags : NONE, links: links.length ? links : NONE };
  }
  override noteCount(): number { return this.one('SELECT count(*) FROM notes')![0]; }
  override filePaths(): string[] { return this.col('SELECT path FROM files'); }
  override notePaths(): string[] { return this.col('SELECT f.path FROM files f JOIN notes n ON n.id = f.id'); }
  override notesIn(folder: string): Note[] {
    // '0' is the character after '/': every path that starts with folder + '/'.
    const paths = this.col('SELECT f.path FROM files f JOIN notes n ON n.id = f.id WHERE f.path >= ? AND f.path < ?', [folder + '/', folder + '0']);
    return paths.map((p) => this.note(p)!);
  }

  // ---------- the matcher's keys ----------
  override addKey(key: string, path: string) {
    const id = this.idOf(path);
    if (id === undefined) return;
    this.write();
    this.run('INSERT OR IGNORE INTO note_keys(kind, key, note) VALUES (?, ?, ?)', [MATCHER, key, id]);
  }
  override removeKey(key: string, path: string) {
    const id = this.idOf(path);
    if (id === undefined) return;
    this.write();
    this.run('DELETE FROM note_keys WHERE kind = ? AND key = ? AND note = ?', [MATCHER, key, id]);
  }
  override keysMadeWith(settings: string): boolean {
    if (this.one("SELECT v FROM meta WHERE k = 'matcher'")?.[0] === settings) return true;
    this.write();
    this.run('DELETE FROM note_keys WHERE kind = ?', [MATCHER]);
    this.run("INSERT OR REPLACE INTO meta(k, v) VALUES ('matcher', ?)", [settings]);
    return false;
  }

  // ---------- changes ----------
  private addFile(path: string): number {
    this.write();
    this.named.clear();
    return this.one('INSERT INTO files(path, name) VALUES (?, ?) RETURNING id', [path, baseOf(fileKeyPath(path))])![0];
  }
  override upsertNote(note: Note) { this.upsertNotes([note]); }
  /**
   * Add or update several notes at once. Each table gets one statement for the whole batch, with
   * the rows sent as JSON and spread out by SQLite (json_each): a statement call costs far more
   * than a row, so a scan goes in batches.
   */
  override upsertNotes(notes: Note[]) {
    if (!notes.length) return;
    this.write();
    const paths = JSON.stringify(notes.map((n) => n.path));
    const ids = new Map<string, number>();
    for (const [p, id] of this.rows('SELECT f.path, f.id FROM json_each(?) j JOIN files f ON f.path = j.value', [paths])) ids.set(p, id);
    const known = new Set(ids.keys());
    if (ids.size) {
      const old = JSON.stringify([...ids.values()]);
      this.run('DELETE FROM link_names WHERE note IN (SELECT value FROM json_each(?))', [old]);
      this.run('DELETE FROM note_keys WHERE kind < ? AND note IN (SELECT value FROM json_each(?))', [MATCHER, old]);
    }
    const added = notes.filter((n) => !known.has(n.path)).map((n) => [n.path, baseOf(fileKeyPath(n.path))]);
    if (added.length) {
      this.named.clear();
      for (const [p, id] of this.rows('INSERT INTO files(path, name) SELECT value ->> 0, value ->> 1 FROM json_each(?) RETURNING path, id', [JSON.stringify(added)])) ids.set(p, id);
    }
    const rows: unknown[] = [], names: unknown[] = [], keys: unknown[] = [];
    for (const n of notes) {
      const id = ids.get(n.path)!;
      rows.push([id, n.size, n.mtime, JSON.stringify(n.aliases), JSON.stringify(n.tags), JSON.stringify(n.links)]);
      for (const [name, links] of this.linksByName(n.links, n.path)) names.push([id, name, JSON.stringify(links)]);
      for (const k of aliasKeys(n)) keys.push([ALIAS, k, id]);
      for (const k of noteTagKeys(n)) keys.push([TAG, k, id]);
    }
    this.run(`INSERT OR REPLACE INTO notes(id, size, mtime, aliases, tags, links)
      SELECT value ->> 0, value ->> 1, value ->> 2, value ->> 3, value ->> 4, value ->> 5 FROM json_each(?)`, [JSON.stringify(rows)]);
    if (names.length) this.run('INSERT INTO link_names(note, name, links) SELECT value ->> 0, value ->> 1, value ->> 2 FROM json_each(?)', [JSON.stringify(names)]);
    if (keys.length) this.run('INSERT OR IGNORE INTO note_keys(kind, key, note) SELECT value ->> 0, value ->> 1, value ->> 2 FROM json_each(?)', [JSON.stringify(keys)]);
    for (const n of notes) for (const fn of this.listeners) fn(n.path, known.has(n.path) ? 'update' : 'add');
  }
  /** Every note's file size and time, by path: what a scan checks each file against. */
  override stamps(): Map<string, { size: number; mtime: number }> {
    const out = new Map<string, { size: number; mtime: number }>();
    for (const [p, size, mtime] of this.rows('SELECT f.path, n.size, n.mtime FROM files f JOIN notes n ON n.id = f.id')) out.set(p, { size, mtime });
    return out;
  }
  override moveNote(from: string, to: string): boolean {
    const note = this.note(from);
    if (!note || this.hasFile(to)) return false;
    const id = this.idOf(from)!;
    for (const fn of this.listeners) fn(from, 'remove');
    this.write();
    this.run('UPDATE files SET path = ?, name = ? WHERE id = ?', [to, baseOf(fileKeyPath(to)), id]);
    this.named.clear();
    // A link's name key can depend on the note's folder (./ and ../ links).
    this.run('DELETE FROM link_names WHERE note = ?', [id]);
    this.addLinkNames(id, note.links, to);
    for (const fn of this.listeners) fn(to, 'add');
    return true;
  }
  override addAttachment(path: string) {
    if (this.hasFile(path)) return;
    this.addFile(path);
    for (const fn of this.listeners) fn(path, 'add');
  }
  override removeFile(path: string) {
    const id = this.idOf(path);
    if (id === undefined) return;
    for (const fn of this.listeners) fn(path, 'remove');
    this.write();
    const isNote = this.one('SELECT 1 FROM notes WHERE id = ?', [id]) !== undefined;
    this.run('DELETE FROM link_names WHERE note = ?', [id]);
    this.run('DELETE FROM note_keys WHERE note = ?', [id]);
    if (isNote) this.run('DELETE FROM notes WHERE id = ?', [id]);
    this.run('DELETE FROM files WHERE id = ?', [id]);
    this.named.clear();
  }
  override build(notes: Note[], attachments: string[]) {
    for (const p of attachments) this.addAttachment(p);
    for (const n of notes) this.upsertNote(n);
    this.flush();
  }
}
