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

test('a full scan answers every query as the in-memory index does', async () => {
  const { files } = gen(600);
  const fs = memFS(files);
  const { mem, sql } = await both(fs);
  await same(mem, sql, titlesOf(files, ['delta/alpha', 'project/plan', 'A/B/alpha beta', ...DAYS]));
  for (const [t, f] of [['./alpha beta', 'A/B/x.md'], ['../idea plan', 'A/B/x.md'], ['ALPHA BETA', ''], ['A/pic.png', '']]) {
    assert.equal(sql.resolve(t, f), mem.resolve(t, f));
  }
});

test('edits, new and deleted notes, and folder moves keep the two the same', async () => {
  const { files } = gen(300, 11);
  const fs = memFS(files);
  const { mem, sql } = await both(fs, ['YYYY-MM-DD']);
  const titles = titlesOf(files, ['moved idea', ...DAYS]);
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
