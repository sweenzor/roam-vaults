// The SQLite index (src/sql) against the in-memory one: every query must answer the same, after a
// full scan and after each kind of change. Runs SQLite's wasm build in Node, with a database in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VaultEngine, type VaultFS, type FileMeta } from '../src/engine.ts';
import { SqlIndex } from '../src/sql/sql-index.ts';
import { openDb } from '../src/sql/db.ts';

function memFS(files: Record<string, string>) {
  const data = new Map(Object.entries(files));
  const mtimes = new Map([...data.keys()].map((k) => [k, 1]));
  let reads = 0;
  const fs: VaultFS & { write(p: string, t: string): void; rm(p: string): void; mv(from: string, to: string): void; reads(): number } = {
    async list(folder = '') {
      const all = [...data].filter(([path]) => !folder || path.startsWith(folder + '/'));
      if (folder && !all.length) throw new DOMException('gone', 'NotFoundError');
      return all.map(([path, t]): FileMeta => ({ path, size: t.length, mtime: mtimes.get(path)! }));
    },
    async readText(p) { reads++; const t = data.get(p); if (t === undefined) throw new Error('missing'); return t; },
    async stat(p) { const t = data.get(p); return t === undefined ? null : { path: p, size: t.length, mtime: mtimes.get(p)! }; },
    write(p, t) { data.set(p, t); mtimes.set(p, (mtimes.get(p) ?? 0) + 1); },
    rm(p) { data.delete(p); mtimes.delete(p); },
    mv(from, to) {
      for (const p of [...data.keys()]) {
        if (p !== from && !p.startsWith(from + '/')) continue;
        const q = to + p.slice(from.length);
        data.set(q, data.get(p)!); mtimes.set(q, mtimes.get(p)!); data.delete(p); mtimes.delete(p);
      }
    },
    reads: () => reads,
  };
  return fs;
}

/** A deterministic vault with duplicate names, relative links, aliases, nested tags and daily notes. */
function gen(n: number, seed = 7) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const W = ['alpha', 'beta', 'gamma', 'Delta', 'project', 'meeting', 'Notes', 'review', 'plan', 'idea', 'garden', 'café', 'naïve'];
  const dirs = ['', 'A', 'A/B', 'B', 'Daily', 'Deep/Er/Est', 'People'];
  const titles: string[] = [];
  for (let i = 0; i < n; i++) titles.push(rnd() < 0.15 ? `2026-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}` : `${pick(W)} ${pick(W)}${rnd() < 0.5 ? ' ' + Math.floor(rnd() * 20) : ''}`);
  const files: Record<string, string> = {};
  for (const t of titles) {
    const dir = /^\d/.test(t) ? 'Daily' : pick(dirs);
    let o = '';
    if (rnd() < 0.5) o += `---\naliases: [${pick(W)} ${pick(W)}]\ntags: [${pick(W)}/${pick(W)}]\n---\n`;
    const k = Math.floor(rnd() * 6);
    for (let j = 0; j < k; j++) {
      const r = rnd(), to = pick(titles);
      o += `- ${pick(W)} ${r < 0.1 ? `[[./${to}]]` : r < 0.2 ? `[[../${to}]]` : r < 0.3 ? `[[${pick(dirs)}/${to}]]` : r < 0.4 ? `![[${to}]]` : r < 0.5 ? `[[${to.toUpperCase()}|x]]` : r < 0.6 ? `[[missing ${pick(W)}]]` : `[[${to}]]`} #${pick(W)}\n`;
    }
    files[`${dir ? dir + '/' : ''}${t}.md`] = o;
  }
  files['A/pic.png'] = '';
  return { files, titles: [...new Set(titles)] };
}

async function sqlEngine(fs: VaultFS, formats?: string[]) {
  const { db } = await openDb('test-' + Math.random());
  return new VaultEngine(fs, formats, new SqlIndex(db));
}
async function both(fs: VaultFS, formats?: string[]) {
  const mem = new VaultEngine(fs, formats), sql = await sqlEngine(fs, formats);
  await mem.build(); await sql.build();
  return { mem, sql };
}
async function shows(e: VaultEngine, titles: string[]) {
  const out: Record<string, unknown> = {};
  for (const t of titles) {
    const r = await e.query(t);
    out[t] = {
      c: r.counterparts.map((c) => [c.path, c.how]),
      b: r.backlinks.map((b) => [b.path, b.lines.map((l) => [l.line, l.text, l.embed, l.unresolved])]),
      t: r.tagged.map((x) => [x.path, x.tag]),
      f: r.inFolders.map((x) => x.path),
    };
  }
  return out;
}
function titlesOf(files: Record<string, string>, extra: string[] = []) {
  const t = new Set(extra);
  for (const p of Object.keys(files)) { const b = p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, ''); t.add(b); t.add(b.toLowerCase()); }
  for (const text of Object.values(files)) for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) t.add(m[1]);
  return [...t];
}
async function same(mem: VaultEngine, sql: VaultEngine, titles: string[], files?: string[]) {
  assert.deepEqual(await shows(sql, titles), await shows(mem, titles));
  assert.equal(sql.idx.noteCount(), mem.idx.noteCount());
  assert.deepEqual(sql.idx.filePaths().sort(), mem.idx.filePaths().sort());
  for (const p of files ?? mem.idx.filePaths()) {
    assert.deepEqual(sql.idx.note(p), mem.idx.note(p), p);
    assert.deepEqual(sql.idx.outgoing(p), mem.idx.outgoing(p), p);
  }
}
const DAYS = ['January 15th, 2026', 'March 12th, 2026', 'September 18th, 2026', 'June 1st, 2026'];
/** Pages named like the folders of gen() and of the tests' moves. */
const FOLDERS = ['A', 'a', 'B', 'A/B', 'Daily', 'People', 'Deep', 'Est', 'Er/Est', 'Deep/Er', 'A2', 'Z', 'Z/A2', 'Nowhere'];

test('a full scan answers every query as the in-memory index does', async () => {
  const { files } = gen(600);
  const fs = memFS(files);
  const { mem, sql } = await both(fs);
  await same(mem, sql, titlesOf(files, ['delta/alpha', 'project/plan', 'A/B/alpha beta', ...DAYS, ...FOLDERS]));
  for (const [t, f] of [['./alpha beta', 'A/B/x.md'], ['../idea plan', 'A/B/x.md'], ['ALPHA BETA', ''], ['A/pic.png', '']]) {
    assert.equal(sql.resolve(t, f), mem.resolve(t, f));
  }
});

test('edits, new and deleted notes, and folder moves keep the two the same', async () => {
  const { files } = gen(300, 11);
  const fs = memFS(files);
  const { mem, sql } = await both(fs, ['YYYY-MM-DD']);
  const titles = titlesOf(files, ['moved idea', ...DAYS, ...FOLDERS]);
  const paths = Object.keys(files);
  // edit a few, add one, delete one
  fs.write(paths[3], '[[moved idea]] and [[' + paths[5].replace(/\.md$/, '') + ']]\n#new/tag');
  fs.write('B/moved idea.md', '---\naliases: [shifted]\n---\n[[./alpha beta]]');
  fs.rm(paths[7]);
  for (const e of [mem, sql]) await e.refresh([paths[3], 'B/moved idea.md', paths[7]]);
  await same(mem, sql, [...titles, 'shifted', 'new/tag']);
  // a folder moved: the in-place index keeps its notes without reading them
  const reads = fs.reads();
  fs.mv('A', 'Z/A2');
  await mem.refreshFolders([{ path: 'Z/A2', from: 'A' }]);
  const memReads = fs.reads() - reads;
  await sql.refreshFolders([{ path: 'Z/A2', from: 'A' }]);
  assert.equal(fs.reads() - reads - memReads, 0, 'nothing is read for a moved folder');
  await same(mem, sql, titles);
  // a folder deleted
  for (const p of paths.filter((p) => p.startsWith('B/'))) fs.rm(p);
  fs.rm('B/moved idea.md');
  for (const e of [mem, sql]) await e.refreshFolders([{ path: 'B' }]);
  await same(mem, sql, titles);
  // the in-place index rescans to the same result as a fresh full scan
  fs.write(paths[10], 'rewritten [[alpha beta]]');
  await sql.build();
  const fresh = new VaultEngine(fs, ['YYYY-MM-DD']); await fresh.build();
  await same(fresh, sql, titles);
});

test('a second scan of an unchanged vault reads nothing', async () => {
  const { files } = gen(200, 3);
  const fs = memFS(files);
  const sql = await sqlEngine(fs);
  const first = await sql.build();
  assert.equal(first.reread, first.notes);
  const reads = fs.reads();
  const again = await sql.build();
  assert.equal(again.reread, 0);
  assert.equal(again.notes, first.notes);
  assert.equal(fs.reads(), reads);
});

test('a vault that lost every file is emptied, and filled again by the next scan', async () => {
  const { files, titles } = gen(120, 5);
  const fs = memFS(files);
  const { mem, sql } = await both(fs);
  const indexes = () => (sql.idx as SqlIndex).db.selectValues("SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN ('files_name', 'link_names_name', 'note_keys_note') ORDER BY name");
  // The indexes a first scan does without are back once it is done.
  assert.deepEqual(indexes(), ['files_name', 'link_names_name', 'note_keys_note']);
  for (const p of Object.keys(files)) fs.rm(p);
  const gone = await sql.build();
  await mem.build();
  assert.equal(gone.notes, 0);
  assert.equal(gone.changed, true);
  assert.equal(sql.idx.isEmpty(), true);
  await same(mem, sql, titles);
  for (const [p, t] of Object.entries(files)) fs.write(p, t);
  const back = await sql.build();
  await mem.build();
  assert.equal(back.reread, back.notes);
  assert.deepEqual(indexes(), ['files_name', 'link_names_name', 'note_keys_note']);
  await same(mem, sql, titles);
});

test('the daily format can change between scans', async () => {
  const fs = memFS({ 'J/09-11-2026.md': 'x', '2026-11-09.md': 'y' });
  const { db } = await openDb('fmt');
  const idx = new SqlIndex(db);
  const a = new VaultEngine(fs, ['YYYY-MM-DD'], idx);
  await a.build();
  assert.deepEqual((await a.query('November 9th, 2026')).counterparts.map((c) => c.path), ['2026-11-09.md']);
  a.matcher.detach();
  const b = new VaultEngine(fs, ['DD-MM-YYYY'], idx);
  await b.build();
  assert.deepEqual((await b.query('November 9th, 2026')).counterparts.map((c) => c.path), ['J/09-11-2026.md']);
});

test('a later start answers from the database before any file is looked at', async () => {
  const { files } = gen(200, 5);
  const fs = memFS(files);
  const { db } = await openDb('start');
  const idx = new SqlIndex(db);
  assert.equal(idx.scanned, false);
  const first = new VaultEngine(fs, undefined, idx);
  await first.build();
  idx.markScanned();
  const titles = titlesOf(files, DAYS);
  const before = await shows(first, titles);
  first.matcher.detach();
  // The next session: the same database, a new engine.
  const reads = fs.reads();
  const again = new SqlIndex(db);
  assert.equal(again.scanned, true);
  const next = new VaultEngine(fs, undefined, again);
  const texts = fs.reads();
  assert.deepEqual(await shows(next, titles), before);
  assert.equal(texts, reads, 'starting reads no file');
  // Its scan changes only what differs on disk, and saves nothing elsewhere.
  const paths = Object.keys(files).filter((p) => p.endsWith('.md'));
  fs.write(paths[1], 'now links [[alpha beta]]');
  fs.write('New/fresh.md', '[[' + paths[2].replace(/\.md$/, '') + ']]');
  fs.write('New/pic two.png', '');
  fs.rm(paths[4]); fs.rm('A/pic.png');
  const stats = await next.check();
  assert.deepEqual([stats.reread, stats.changed, stats.notes], [2, true, paths.length]);
  assert.equal(next.unsaved.size, 0);
  const fresh = new VaultEngine(fs); await fresh.build();
  await same(fresh, next, [...titles, 'fresh']);
  const none = await next.check();
  assert.deepEqual([none.reread, none.changed], [0, false]);
});

test('a scan handed over in batches fills the database like one in memory, and drops a note that can no longer be read', async () => {
  const { files } = gen(300, 9);
  const mfs = memFS(files);
  let unreadable = '';
  // Three batches in hand at once, as the walker gives them.
  const fs: VaultFS = {
    ...mfs,
    async scan(each) {
      const all = await mfs.list();
      const batches: FileMeta[][] = [];
      for (let i = 0; i < all.length; i += 40) batches.push(all.slice(i, i + 40));
      for (let i = 0; i < batches.length; i += 3) {
        await Promise.all(batches.slice(i, i + 3).map((b) => each(b, async (want) =>
          Promise.all(want.map((k) => b[k].path === unreadable ? null : mfs.readText(b[k].path))))));
      }
    },
  };
  const { mem, sql } = await both(fs);
  const titles = titlesOf(files, DAYS);
  await same(mem, sql, titles);
  assert.deepEqual(sql.idx.pathsIn('A').sort(), mem.idx.pathsIn('A').sort());
  assert.deepEqual(sql.idx.pathsIn('Deep/Er').sort(), mem.idx.pathsIn('Deep/Er').sort());
  unreadable = Object.keys(files)[6];
  mfs.write(unreadable, 'changed');
  const stats = await sql.check();
  assert.equal(stats.errors.length, 1);
  assert.ok(!sql.idx.hasFile(unreadable));
  const fresh = new VaultEngine(fs); await fresh.build();
  await same(fresh, sql, titles);
});

test('the folders table is filled from the notes of a database made before it', async () => {
  const { files } = gen(200, 5);
  const { db } = await openDb('test-' + Math.random());
  const e = new VaultEngine(memFS(files), undefined, new SqlIndex(db));
  await e.build();
  const dirs = () => JSON.stringify(db.selectArrays('SELECT path, name, n FROM dirs ORDER BY path'));
  const before = dirs();
  assert.ok(before.includes('["Deep/Er/Est","est",'), before);
  const { MIGRATIONS, migrate } = await import('../src/sql/schema.ts');
  db.exec(`DROP TABLE dirs; PRAGMA user_version = ${MIGRATIONS.length - 1}`);
  migrate(db);
  assert.equal(dirs(), before);
});

test('a database from a build where the folders table was step 3 or 5 comes out whole', async () => {
  const { MIGRATIONS, migrate } = await import('../src/sql/schema.ts');
  for (const step of [3, 5]) {
    const { files } = gen(200, 5);
    const { db } = await openDb('test-' + Math.random());
    const fs = memFS(files);
    const e = new VaultEngine(fs, undefined, new SqlIndex(db));
    await e.build();
    const dirs = () => JSON.stringify(db.selectArrays('SELECT path, name, n FROM dirs ORDER BY path'));
    const before = dirs();
    // Those builds had the table and stopped at that step, without the column main added as step 5:
    // the steps after it empty the notes, add the column and make the table again.
    e.matcher.detach();
    db.exec(`ALTER TABLE notes DROP COLUMN okf; PRAGMA user_version = ${step}`);
    migrate(db);
    assert.equal(Number(db.selectValue('PRAGMA user_version')), MIGRATIONS.length);
    assert.equal(db.selectValues("SELECT name FROM pragma_table_info('notes') WHERE name = 'okf'").length, 1);
    assert.equal(dirs(), '[]', 'no folders are left over from notes that are gone');
    const again = new VaultEngine(fs, undefined, new SqlIndex(db));
    await again.build();
    assert.equal(dirs(), before);
  }
});

test('OKF bundles: found from index.md, kept across starts, followed by links and names', async () => {
  const files = {
    'notes/loose.md': '---\ntitle: Not a bundle\ntype: Supplier\n---\n[x](recipes/bread.md)\n',
    'recipes/bread.md': 'elsewhere',
    'kb/index.md': '---\nokf_version: "0.3"\ntitle: Bakery\n---\n',
    'kb/recipes/bread.md': '---\ntype: Recipe\ntitle: Country Bread\n---\n[x](../suppliers/mill.md) [y](/suppliers/mill.md) [z](flour.md)\n',
    'kb/recipes/flour.md': '---\ntype: Ingredient\n---\n',
    'kb/suppliers/mill.md': '---\ntype: Supplier\ntitle: The Mill\n---\n[back](recipes/bread.md)\n',
    'kb/suppliers/recipes/bread.md': 'a note in the way',
  };
  const fs = memFS(files);
  const { mem, sql } = await both(fs);
  for (const e of [mem, sql]) {
    assert.deepEqual(e.idx.bundleRoots(), ['kb']);
    assert.equal(e.name('kb/recipes/bread.md'), 'Country Bread');
    assert.equal(e.name('notes/loose.md'), 'loose', 'a title outside a bundle is an alias, not the name');
    assert.equal(e.resolve('/suppliers/mill.md', 'kb/recipes/bread.md'), 'kb/suppliers/mill.md');
    assert.equal(e.resolve('recipes/bread.md', 'kb/suppliers/mill.md'), 'kb/suppliers/recipes/bread.md', 'from the linking file\'s folder first');
    assert.equal(e.resolve('recipes/bread.md', 'notes/loose.md'), 'recipes/bread.md', 'outside a bundle, from the vault\'s folder');
    const r = await e.query('The Mill');
    assert.deepEqual(r.counterparts.map((c) => c.title), ['The Mill']);
    assert.deepEqual(r.backlinks.map((b) => b.title), ['Country Bread']);
    assert.deepEqual(r.bundles, ['kb']);
    const sup = await e.query('Supplier');
    assert.deepEqual(sup.backlinks.map((b) => [b.title, b.lines.map((l) => [l.line, l.text])]), [['The Mill', [[1, 'type:: [[Supplier]]']]]]);
  }
  // The next start answers from the database; an index.md that stops saying okf_version ends the bundle.
  sql.matcher.detach();
  const again = new VaultEngine(fs, undefined, new SqlIndex(sql.idx.db));
  assert.equal(again.name('kb/suppliers/mill.md'), 'The Mill');
  fs.write('kb/index.md', '---\ntitle: Bakery\n---\n');
  await again.refresh(['kb/index.md']);
  assert.deepEqual(again.idx.bundleRoots(), []);
  assert.equal(again.name('kb/suppliers/mill.md'), 'mill');
  assert.deepEqual((await again.query('Supplier')).backlinks, [], 'a type outside a bundle is a word');
});
