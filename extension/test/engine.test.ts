import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VaultEngine, type VaultFS, type FileMeta } from '../src/engine.ts';

/** In-memory vault. mtime bumps on every write so the cache logic is exercised. */
function memFS(files: Record<string, string>) {
  const data = new Map(Object.entries(files));
  const mtimes = new Map([...data.keys()].map((k) => [k, 1]));
  let reads = 0;
  const fs: VaultFS & { write(p: string, t: string): void; rm(p: string): void; reads(): number } = {
    async list() { return [...data].map(([path, t]): FileMeta => ({ path, size: t.length, mtime: mtimes.get(path)! })); },
    async readText(p) { reads++; const t = data.get(p); if (t === undefined) throw new Error('missing'); return t; },
    async stat(p) { const t = data.get(p); return t === undefined ? null : { path: p, size: t.length, mtime: mtimes.get(p)! }; },
    write(p, t) { data.set(p, t); mtimes.set(p, (mtimes.get(p) ?? 0) + 1); },
    rm(p) { data.delete(p); mtimes.delete(p); },
    reads: () => reads,
  };
  return fs;
}

const vault = {
  'Projects/Project Alpha.md': '---\naliases: [Alpha]\ntags: [project]\n---\n# Project Alpha\nKickoff with [[Hiring neural]].\n',
  'Zettel/Hiring neural.md': 'Notes about hiring.\n- see [[Project Alpha]] for context\n- also #project/alpha\n',
  'Daily/2026-11-09.md': '- met about [[Project Alpha|the alpha project]]\n- [[Ridley Scott]] film night\n',
  'People/Someone.md': '---\ndirector: "[[Ridley Scott]]"\n---\nbody\n',
  'project alpha.md': 'a case-only duplicate\n',
  'img/diagram.png': '',
};

test('counterparts, backlinks with snippets, unresolved links and tags', async () => {
  const e = new VaultEngine(memFS(vault));
  const stats = await e.build();
  assert.equal(stats.notes, 5);

  const r = await e.query('Project Alpha');
  assert.deepEqual(r.counterparts.map((c) => [c.path, c.how]), [
    ['Projects/Project Alpha.md', 'exact'],
    ['project alpha.md', 'case'],
  ]);
  const bl = Object.fromEntries(r.backlinks.map((b) => [b.path, b.lines.map((l) => l.text)]));
  assert.deepEqual(bl['Zettel/Hiring neural.md'], ['see [[Project Alpha]] for context']);
  assert.deepEqual(bl['Daily/2026-11-09.md'], ['met about [[Project Alpha|the alpha project]]']);
  assert.ok(!r.backlinks.some((b) => b.path === 'Projects/Project Alpha.md'), 'no self links');

  const alias = await e.query('Alpha');
  assert.deepEqual(alias.counterparts.map((c) => c.how), ['alias']);

  // A page with no file in the vault still collects unresolved links, including frontmatter properties.
  const rs = await e.query('Ridley Scott');
  assert.equal(rs.counterparts.length, 0);
  assert.deepEqual(rs.backlinks.map((b) => b.path).sort(), ['Daily/2026-11-09.md', 'People/Someone.md']);
  assert.ok(rs.backlinks.every((b) => b.lines.every((l) => l.unresolved)));

  // Roam namespace "project/alpha" <-> nested tag
  const tagged = await e.query('project/alpha');
  assert.deepEqual(tagged.tagged.map((t) => t.path), ['Zettel/Hiring neural.md']);

  // Daily notes: Roam title -> vault daily note
  const day = await e.query('November 9th, 2026');
  assert.deepEqual(day.counterparts.map((c) => [c.path, c.how]), [['Daily/2026-11-09.md', 'daily']]);
});

test('cache skips unchanged files; refresh picks up edits, new files, renames and deletes', async () => {
  const fs = memFS(vault);
  const e1 = new VaultEngine(fs);
  await e1.build();
  const before = fs.reads();
  const e2 = new VaultEngine(fs);
  const s2 = await e2.build(e1.cache);
  assert.equal(s2.reread, 0);
  assert.equal(fs.reads(), before);

  // new note linking to the page
  fs.write('Inbox/new.md', 'fresh link to [[Project Alpha]]\n');
  assert.equal(await e2.refresh(['Inbox/new.md']), true);
  assert.ok((await e2.query('Project Alpha')).backlinks.some((b) => b.path === 'Inbox/new.md'));

  // rename: old path disappears, new one appears
  fs.write('Inbox/renamed.md', 'fresh link to [[Project Alpha]]\n'); fs.rm('Inbox/new.md');
  await e2.refresh(['Inbox/new.md', 'Inbox/renamed.md']);
  const paths = (await e2.query('Project Alpha')).backlinks.map((b) => b.path);
  assert.ok(paths.includes('Inbox/renamed.md') && !paths.includes('Inbox/new.md'));

  // edit removes the link
  fs.write('Inbox/renamed.md', 'no links now\n');
  await e2.refresh(['Inbox/renamed.md']);
  assert.ok(!(await e2.query('Project Alpha')).backlinks.some((b) => b.path === 'Inbox/renamed.md'));

  // deleting the counterpart turns links to it into unresolved-by-text matches
  fs.rm('Projects/Project Alpha.md'); fs.rm('project alpha.md');
  await e2.refresh(['Projects/Project Alpha.md', 'project alpha.md']);
  const after = await e2.query('Project Alpha');
  assert.equal(after.counterparts.length, 0);
  assert.ok(after.backlinks.length >= 2);

  // unchanged file: no-op
  assert.equal(await e2.refresh(['Zettel/Hiring neural.md']), false);
});

test('custom daily format and resolve()', async () => {
  const e = new VaultEngine(memFS({ 'Journal/2026/11/09-11-2026.md': 'x', 'A.md': '[[B]]', 'sub/B.md': '' }), ['YYYY/MM/DD-MM-YYYY', 'YYYY-MM-DD']);
  await e.build();
  assert.deepEqual((await e.query('November 9th, 2026')).counterparts.map((c) => c.path), ['Journal/2026/11/09-11-2026.md']);
  assert.equal(e.resolve('B', 'A.md'), 'sub/B.md');
  assert.equal(e.resolve('Nope', 'A.md'), null);
});
