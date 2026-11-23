import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VaultEngine, type VaultFS, type FileMeta } from '../src/engine.ts';

/** In-memory vault. mtime bumps on every write so the cache logic is exercised. */
function memFS(files: Record<string, string>) {
  const data = new Map(Object.entries(files));
  const mtimes = new Map([...data.keys()].map((k) => [k, 1]));
  let reads = 0;
  const fs: VaultFS & { write(p: string, t: string): void; rm(p: string): void; mv(from: string, to: string): void; reads(): number; lists: string[] } = {
    async list(folder = '') {
      fs.lists.push(folder);
      const all = [...data].filter(([path]) => !folder || path.startsWith(folder + '/'));
      if (folder && !all.length) throw new DOMException('gone', 'NotFoundError');
      return all.map(([path, t]): FileMeta => ({ path, size: t.length, mtime: mtimes.get(path)! }));
    },
    lists: [],
    async readText(p) { reads++; const t = data.get(p); if (t === undefined) throw new Error('missing'); return t; },
    async stat(p) { const t = data.get(p); return t === undefined ? null : { path: p, size: t.length, mtime: mtimes.get(p)! }; },
    write(p, t) { data.set(p, t); mtimes.set(p, (mtimes.get(p) ?? 0) + 1); },
    rm(p) { data.delete(p); mtimes.delete(p); },
    /** Rename a file or a folder; moved files keep their size and time, as on disk. */
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

test('only changed notes are queued for the cache', async () => {
  const fs = memFS(vault);
  const e1 = new VaultEngine(fs);
  await e1.build();
  assert.deepEqual([...e1.unsaved.keys()].sort(), Object.keys(vault).filter((p) => p.endsWith('.md')).sort());
  assert.ok([...e1.unsaved.values()].every((n) => n && n.size > 0 && n.mtime === 1));

  // nothing changed: nothing to write
  const e2 = new VaultEngine(fs);
  await e2.build(e1.cache);
  assert.equal(e2.unsaved.size, 0);

  // an edit, a new note and a delete queue exactly those three
  fs.write('Zettel/Hiring neural.md', 'rewritten\n');
  fs.write('Inbox/new.md', '[[Project Alpha]]\n');
  fs.rm('People/Someone.md');
  await e2.refresh(['Zettel/Hiring neural.md', 'Inbox/new.md', 'People/Someone.md', 'Daily/2026-11-09.md', 'img/diagram.png']);
  assert.deepEqual([...e2.unsaved].map(([p, n]) => [p, n === null ? null : n.path]).sort(), [
    ['Inbox/new.md', 'Inbox/new.md'], ['People/Someone.md', null], ['Zettel/Hiring neural.md', 'Zettel/Hiring neural.md'],
  ]);

  // a rescan finds what changed while nothing was watching, and drops notes that are gone
  fs.write('Daily/2026-11-09.md', 'changed while Roam was closed\n');
  fs.rm('project alpha.md');
  const e3 = new VaultEngine(fs);
  const s3 = await e3.build(e2.cache);
  assert.equal(s3.reread, 1);
  assert.deepEqual([...e3.unsaved].map(([p, n]) => [p, n !== null]).sort(), [['Daily/2026-11-09.md', true], ['project alpha.md', false]]);
  assert.ok(!e3.cache.has('project alpha.md') && e3.cache.has('Inbox/new.md'));
});

test('snippets come from the right line, and note text is read once while it stays unchanged', async () => {
  const long = Array.from({ length: 400 }, (_, i) => (i === 250 ? '- deep down [[Target]] here\r' : `filler line ${i}`)).join('\n');
  const fs = memFS({ 'Target.md': 'x', 'Long.md': long, 'Last.md': 'first\n\n[[Target]]', 'One.md': '[[Target]] start' });
  const e = new VaultEngine(fs);
  await e.build();
  const lines = async () => Object.fromEntries((await e.query('Target')).backlinks.map((b) => [b.path, b.lines.map((l) => [l.line, l.text])]));
  const want = { 'Last.md': [[2, '[[Target]]']], 'Long.md': [[250, 'deep down [[Target]] here']], 'One.md': [[0, '[[Target]] start']] };
  assert.deepEqual(await lines(), want);
  const reads = fs.reads();
  assert.deepEqual(await lines(), want);
  assert.equal(fs.reads(), reads, 'a second look at the same page reads nothing');
  fs.write('One.md', 'moved\n[[Target]] down a line');
  await e.refresh(['One.md']);
  assert.deepEqual((await lines())['One.md'], [[1, 'moved [[Target]] down a line']]);
});

test('a page many notes link to keeps a bounded amount of note text', async () => {
  const files: Record<string, string> = { 'Hub.md': 'hub' };
  const body = 'x'.repeat(20_000);
  for (let i = 0; i < 150; i++) files[`n/Note ${String(i).padStart(3, '0')}.md`] = `[[Hub]] from ${i}\n${body}`;
  files['Huge.md'] = `${'y'.repeat(400_000)}\n[[Hub]] at the end`;
  const e = new VaultEngine(memFS(files));
  await e.build();
  const r = await e.query('Hub');
  assert.equal(r.backlinks.length, 151);
  assert.ok(r.backlinks.every((b) => b.lines[0].text.startsWith('[[Hub]]')), 'the line with the link is the text, also where its paragraph is too long to show');
  const kept = (e as any).texts as Map<string, string>;
  const chars = [...kept.values()].reduce((a, t) => a + t.length, 0);
  assert.ok(chars <= 1_000_000 && chars === (e as any).textChars, `kept ${chars} characters`);
  assert.ok(!kept.has('Huge.md'), 'a very large note is not kept');
});

test('a page asks for the lines of the notes it draws first, and for the rest when it gets to them', async () => {
  const files: Record<string, string> = { 'Hub.md': 'hub' };
  for (let i = 0; i < 150; i++) files[`n/Note ${String(i).padStart(3, '0')}.md`] = `intro\n- [[Hub]] from ${i}\n`;
  const fs = memFS(files);
  const e = new VaultEngine(fs);
  await e.build();
  const before = fs.reads();
  const r = await e.query('Hub', 60);
  assert.equal(r.backlinks.length, 150);
  assert.equal(fs.reads() - before, 60, 'only the first notes are read');
  assert.deepEqual(r.backlinks.slice(0, 60).map((b) => [b.unread, b.lines[0].text]), Array.from({ length: 60 }, (_, i) => [undefined, `[[Hub]] from ${i}`]));
  assert.ok(r.backlinks.slice(60).every((b) => b.unread && b.lines[0].line === 1 && b.lines[0].text === ''));
  const rest = r.backlinks.slice(60, 100);
  const texts = await e.lines([...rest.map((b) => ({ path: b.path, lines: b.lines.map((l) => l.line) })), { path: 'gone.md', lines: [0] }]);
  assert.deepEqual(texts.map((t) => t && t.map((l) => l.text)), [...rest.map((_, i) => [`[[Hub]] from ${60 + i}`]), null]);
  assert.equal(fs.reads() - before, 101, 'the notes asked for, and a try at the one that is gone');
  const all = await e.query('Hub');
  assert.ok(all.backlinks.every((b) => !b.unread && b.lines[0].text.startsWith('[[Hub]] from')), 'asked for whole, a page comes whole');
});

/** What a page shows, in a form two engines can be compared by. */
async function shows(e: VaultEngine, titles: string[]) {
  const out: Record<string, unknown> = {};
  for (const t of titles) {
    const r = await e.query(t);
    out[t] = { c: r.counterparts.map((c) => [c.path, c.how]), b: r.backlinks.map((b) => [b.path, b.lines.map((l) => [l.line, l.text, l.unresolved])]), t: r.tagged.map((x) => x.path) };
  }
  return out;
}
const TITLES = ['Project Alpha', 'Alpha', 'Hiring neural', 'Ridley Scott', 'project/alpha', 'November 9th, 2026', 'Kept', 'Moved note', 'New idea'];
/** The index a full scan of the same files builds. */
async function fresh(fs: ReturnType<typeof memFS>) { const e = new VaultEngine(fs); await e.build(); return e; }

test('a folder that appears is walked, with the notes inside it', async () => {
  const fs = memFS(vault);
  const e = await fresh(fs);
  fs.lists.length = 0;
  fs.write('Inbox/Deep/New idea.md', '- about [[Project Alpha]]\n- #project\n');
  fs.write('Inbox/Deep/pic.png', '');
  fs.write('Inbox/Other.md', '[[New idea]]\n');
  const reads = fs.reads();
  // the watcher reports the outer folder, and maybe a folder inside it too
  assert.equal(await e.refreshFolders([{ path: 'Inbox/Deep' }, { path: 'Inbox' }]), true);
  assert.deepEqual(fs.lists, ['Inbox'], 'only the outer folder is walked, once');
  assert.equal(fs.reads() - reads, 2, 'only the new notes are read');
  assert.deepEqual(await shows(e, TITLES), await shows(await fresh(fs), TITLES));
  assert.ok(e.idx.files.has('Inbox/Deep/pic.png'));
  assert.deepEqual([...e.unsaved.keys()].filter((p) => p.startsWith('Inbox')).sort(), ['Inbox/Deep/New idea.md', 'Inbox/Other.md']);
  // walking it again changes nothing
  assert.equal(await e.refreshFolders([{ path: 'Inbox' }]), false);
});

test('a folder that goes away takes its notes, and only its notes, with it', async () => {
  const fs = memFS({ ...vault, 'Projects 2/Kept.md': '[[Project Alpha]]\n' });
  const e = await fresh(fs);
  e.unsaved.clear();
  fs.rm('Projects/Project Alpha.md');
  assert.equal(await e.refreshFolders([{ path: 'Projects' }]), true);
  assert.ok(!e.idx.files.has('Projects/Project Alpha.md'));
  assert.ok(e.idx.files.has('Projects 2/Kept.md'), 'a folder whose name starts the same is kept');
  assert.deepEqual([...e.unsaved], [['Projects/Project Alpha.md', null]]);
  assert.deepEqual(await shows(e, TITLES), await shows(await fresh(fs), TITLES));
});

test('a moved folder keeps its notes under the new name without reading them again', async () => {
  const fs = memFS({ ...vault, 'Projects/Deep/Moved note.md': '[[Project Alpha]] and [[./Kept]]\n', 'Projects/Deep/Kept.md': 'kept\n' });
  const e = await fresh(fs);
  e.unsaved.clear();
  fs.mv('Projects', 'Archive/Old projects');
  const reads = fs.reads();
  assert.equal(await e.refreshFolders([{ path: 'Archive/Old projects', from: 'Projects' }]), true);
  assert.equal(fs.reads(), reads, 'nothing is read');
  assert.ok(![...e.idx.files.keys()].some((p) => p.startsWith('Projects/')));
  assert.equal(e.resolve('./Kept', 'Archive/Old projects/Deep/Moved note.md'), 'Archive/Old projects/Deep/Kept.md');
  assert.deepEqual(await shows(e, TITLES), await shows(await fresh(fs), TITLES));
  assert.deepEqual([...e.unsaved].map(([p, n]) => [p, n?.path ?? null]).sort(), [
    ['Archive/Old projects/Deep/Kept.md', 'Archive/Old projects/Deep/Kept.md'],
    ['Archive/Old projects/Deep/Moved note.md', 'Archive/Old projects/Deep/Moved note.md'],
    ['Archive/Old projects/Project Alpha.md', 'Archive/Old projects/Project Alpha.md'],
    ['Projects/Deep/Kept.md', null], ['Projects/Deep/Moved note.md', null], ['Projects/Project Alpha.md', null],
  ]);
  // a note edited during the move is read again
  fs.mv('Archive/Old projects', 'Projects');
  fs.write('Projects/Deep/Kept.md', 'edited on the way\n');
  const reads2 = fs.reads();
  await e.refreshFolders([{ path: 'Projects', from: 'Archive/Old projects' }]);
  assert.equal(fs.reads(), reads2 + 1);
  assert.deepEqual(await shows(e, TITLES), await shows(await fresh(fs), TITLES));
});

test('a folder event for a path that is a file, or that is gone, is handled', async () => {
  const fs = memFS({ ...vault, 'LICENSE': 'MIT' });
  const e = await fresh(fs);
  // no such folder: nothing to do
  assert.equal(await e.refreshFolders([{ path: 'Nowhere' }]), false);
  // a file without an extension that went away
  fs.rm('LICENSE');
  assert.equal(await e.refreshFolders([{ path: 'LICENSE' }]), true);
  assert.ok(!e.idx.files.has('LICENSE'));
  // a folder that can't be listed for another reason keeps its notes until each is checked
  const list = fs.list;
  fs.list = async (f) => { if (f) throw new DOMException('denied', 'NotAllowedError'); return list(f); };
  assert.equal(await e.refreshFolders([{ path: 'Zettel' }]), false);
  assert.ok(e.idx.files.has('Zettel/Hiring neural.md'));
});

/** The same vault handed over a few files at a time, as the walker does. */
function scanning(fs: ReturnType<typeof memFS>, size = 2) {
  const asked: string[] = [];
  const s: VaultFS & { asked: string[] } = {
    ...fs,
    asked,
    async scan(each) {
      const all = await fs.list();
      const batches: Promise<void>[] = [];
      for (let i = 0; i < all.length; i += size) {
        const batch = all.slice(i, i + size);
        batches.push(each(batch, async (want) => {
          await new Promise((r) => setTimeout(r, 5 * (all.length - i))); // later batches answer first
          return Promise.all(want.map((k) => { asked.push(batch[k].path); return batch[k].path === 'Broken.md' ? null : fs.readText(batch[k].path); }));
        }));
      }
      await Promise.all(batches);
    },
  };
  return s;
}

test('a scan fed in batches builds the same index, and reads only what the cache lacks', async () => {
  const fs = memFS({ ...vault, 'pic.png': '', 'Broken.md': 'never read' });
  const plain = new VaultEngine(memFS({ ...vault, 'pic.png': '' }));
  const want = await plain.build();
  const sfs = scanning(fs);
  const e = new VaultEngine(sfs);
  const progress: [number, number][] = [];
  const stats = await e.build(new Map(), (d, t) => progress.push([d, t]));
  assert.deepEqual(await shows(e, TITLES), await shows(plain, TITLES));
  assert.deepEqual([...e.idx.notes.keys()], [...plain.idx.notes.keys()], 'notes are in the order walked, whichever batch answers first');
  assert.equal(stats.notes, want.notes);
  assert.equal(stats.files, want.files + 1);
  assert.equal(stats.reread, want.reread);
  assert.deepEqual(stats.errors, ['Broken.md: NotReadableError']);
  assert.ok(e.idx.files.has('pic.png'));
  assert.deepEqual(progress, [[stats.notes + 1, stats.notes + 1]], 'a first scan has no total to count towards');

  // again, from that scan's notes: one note changed, one gone
  fs.write('Zettel/Hiring neural.md', 'Rewritten, about [[Ridley Scott]].\n');
  fs.rm('project alpha.md');
  sfs.asked.length = 0; progress.length = 0;
  const next = new VaultEngine(sfs);
  const again = await next.build(e.cache, (d, t) => progress.push([d, t]));
  assert.deepEqual(sfs.asked.sort(), ['Broken.md', 'Zettel/Hiring neural.md']);
  assert.equal(again.reread, 1);
  assert.equal(next.unsaved.get('project alpha.md'), null);
  assert.ok(progress.length > 1 && progress.every(([d, t]) => d <= t && t >= again.notes), 'counts towards the notes there were');
  const fresh2 = new VaultEngine(memFS(Object.fromEntries(Object.entries(vault).filter(([p]) => p !== 'project alpha.md').map(([p, t]) => [p, p === 'Zettel/Hiring neural.md' ? 'Rewritten, about [[Ridley Scott]].\n' : t]))));
  await fresh2.build();
  assert.deepEqual(await shows(next, TITLES), await shows(fresh2, TITLES));
});

for (const how of ['listed', 'handed over in batches'] as const) {
  test(`a vault that has an index is checked in place (${how})`, async () => {
    const fs = memFS({ ...vault, 'pic.png': '' });
    const first = await fresh(fs);
    const use = how === 'listed' ? fs : scanning(fs);
    // a later session: the notes come from the cache, the files have not been looked at yet
    const e = new VaultEngine(use);
    e.adopt(new Map(first.cache));
    assert.deepEqual(await shows(e, TITLES), await shows(first, TITLES), 'answers from the cache before any file is read');
    assert.ok(!e.idx.files.has('pic.png'), 'attachments are not in the cache');

    let reads = fs.reads();
    const same = await e.check();
    assert.equal(fs.reads() - reads, 0, 'nothing is read while sizes and times match');
    assert.deepEqual([same.reread, same.notes, same.files], [0, first.idx.notes.size, first.idx.files.size]);
    assert.ok(e.idx.files.has('pic.png'));
    assert.equal(e.unsaved.size, 0);
    assert.equal((await e.check()).changed, false, 'a check that finds nothing new says so');

    fs.write('Zettel/Hiring neural.md', 'Rewritten, about [[Ridley Scott]].\n');
    fs.write('Inbox/New idea.md', '- about [[Project Alpha]]\n- #project\n');
    fs.write('doc.pdf', '');
    fs.rm('project alpha.md');
    fs.rm('pic.png');
    reads = fs.reads();
    const progress: [number, number][] = [];
    const stats = await e.check((d, t) => progress.push([d, t]));
    assert.equal(fs.reads() - reads, 2, 'only the changed and the new note are read');
    assert.deepEqual([stats.changed, stats.reread, stats.notes], [true, 2, first.idx.notes.size]);
    assert.deepEqual(await shows(e, TITLES), await shows(await fresh(fs), TITLES));
    assert.deepEqual([...e.idx.files.keys()].sort(), [...(await fresh(fs)).idx.files.keys()].sort());
    assert.deepEqual([...e.unsaved].map(([p, n]) => [p, !!n]).sort(), [['Inbox/New idea.md', true], ['Zettel/Hiring neural.md', true], ['project alpha.md', false]]);
    assert.ok(progress.every(([d, t]) => d <= t), 'progress never passes its total');
    assert.deepEqual(progress.at(-1), [stats.notes, stats.notes]);
  });
}

test('the notes in a folder named like the page are listed, the nearest first', async () => {
  const fs = memFS({
    'Work/_PROJECTS/P - Build the shed/Plan.md': 'plan\n',
    'Work/_PROJECTS/P - Build the shed/Quotes/Lumber.md': 'quote\n',
    'Work/_PROJECTS/P - Build the shed/Quotes/invoice.pdf': '',
    'Work/_PROJECTS/P - Build the shed/sketch.png': '',
    'Work/_ARCHIVE/p - build the SHED/Old.md': 'old\n',
    'Areas/Home/Garden.md': 'g\n',
    'Areas/Home/Home.md': 'the folder\'s own note\n',
    'Areas/Home/Bills/2026.md': 'about [[Home]]\n',
    'Other/Home.md': 'a note, not a folder\n',
    'Scans/receipt.pdf': '',
  });
  const e = new VaultEngine(fs);
  await e.build();
  const inFolders = async (title: string) => (await e.query(title)).inFolders.map((n) => n.path);

  // Any letter case, at any depth; notes only; a folder's own notes before those in its subfolders.
  assert.deepEqual(await inFolders('P - Build the shed'), [
    'Work/_ARCHIVE/p - build the SHED/Old.md',
    'Work/_PROJECTS/P - Build the shed/Plan.md',
    'Work/_PROJECTS/P - Build the shed/Quotes/Lumber.md',
  ]);
  assert.deepEqual(await inFolders('Quotes'), ['Work/_PROJECTS/P - Build the shed/Quotes/Lumber.md']);
  assert.deepEqual(await inFolders('Nothing here'), []);
  assert.deepEqual(await inFolders('Scans'), [], 'a folder with no note in it is not one');

  // A namespaced title matches a folder by its path's end.
  assert.deepEqual(await inFolders('Areas/Home'), ['Areas/Home/Garden.md', 'Areas/Home/Home.md', 'Areas/Home/Bills/2026.md']);
  assert.deepEqual(await inFolders('Work/Home'), []);
  // A note that is the page, or links to it, is listed as that, and not again for its folder.
  const home = await e.query('Home');
  assert.deepEqual(home.counterparts.map((c) => c.path), ['Areas/Home/Home.md', 'Other/Home.md']);
  assert.deepEqual(home.backlinks.map((b) => b.path), ['Areas/Home/Bills/2026.md']);
  // `from`: where the folder named like the page starts in the path.
  assert.deepEqual(home.inFolders, [{ path: 'Areas/Home/Garden.md', title: 'Garden', from: 6 }]);
  assert.deepEqual((await e.query('Areas/Home')).inFolders.map((n) => n.from), [0, 0, 0], 'a folder at the top of the vault');
  assert.deepEqual((await e.query('P - Build the shed')).inFolders.map((n) => n.path.slice(n.from).split('/')[0]),
    ['p - build the SHED', 'P - Build the shed', 'P - Build the shed']);
  assert.deepEqual((await e.query('_PROJECTS/P - Build the shed')).inFolders.map((n) => n.path.slice(0, n.from)), ['Work/', 'Work/']);

  // A folder of the same name inside a matched one (a copy kept in a subfolder) adds nothing twice.
  fs.write('Work/_PROJECTS/P - Build the shed/Old copy/P - Build the shed/Draft.md', 'draft\n');
  await e.refresh(['Work/_PROJECTS/P - Build the shed/Old copy/P - Build the shed/Draft.md']);
  assert.deepEqual((await inFolders('P - Build the shed')).slice(1), [
    'Work/_PROJECTS/P - Build the shed/Plan.md',
    'Work/_PROJECTS/P - Build the shed/Quotes/Lumber.md',
    'Work/_PROJECTS/P - Build the shed/Old copy/P - Build the shed/Draft.md',
  ]);
  fs.rm('Work/_PROJECTS/P - Build the shed/Old copy/P - Build the shed/Draft.md');
  await e.refresh(['Work/_PROJECTS/P - Build the shed/Old copy/P - Build the shed/Draft.md']);

  // Notes coming and going keep it current; an emptied folder stops matching.
  fs.write('Work/_PROJECTS/P - Build the shed/Notes/Day 1.md', 'day\n');
  await e.refresh(['Work/_PROJECTS/P - Build the shed/Notes/Day 1.md']);
  assert.deepEqual(await inFolders('Notes'), ['Work/_PROJECTS/P - Build the shed/Notes/Day 1.md']);
  assert.equal((await inFolders('P - Build the shed')).length, 4);
  fs.rm('Work/_ARCHIVE/p - build the SHED/Old.md');
  await e.refresh(['Work/_ARCHIVE/p - build the SHED/Old.md']);
  assert.equal((await inFolders('P - Build the shed')).length, 3);
  assert.deepEqual(e.idx.foldersNamed('p - build the shed'), ['Work/_PROJECTS/P - Build the shed']);

  // A folder moved to the archive is found at its new path, with all its notes.
  fs.mv('Work/_PROJECTS/P - Build the shed', 'Work/_ARCHIVE/2026_11 - P - Build the shed');
  await e.refreshFolders([{ path: 'Work/_ARCHIVE/2026_11 - P - Build the shed', from: 'Work/_PROJECTS/P - Build the shed' }]);
  assert.deepEqual(await inFolders('P - Build the shed'), []);
  assert.equal((await inFolders('2026_11 - P - Build the shed')).length, 3);
});

test('an embedded picture is found the way a link is, and is never a note', async () => {
  const e = await fresh(memFS({ 'A.md': '![[crumb.png]]', 'sub/B.md': '![x](pictures/crumb.png)', 'pictures/crumb.png': 'png', 'crumb.md': 'a note of the same name' }));
  assert.equal(e.resolveFile('crumb.png', 'A.md'), 'pictures/crumb.png');
  assert.equal(e.resolveFile('pictures/crumb.png', 'sub/B.md'), 'pictures/crumb.png');
  assert.equal(e.resolveFile('crumb', 'A.md'), null);
  assert.equal(e.resolveFile('missing.png', 'A.md'), null);
});

test('a date in a property is a reference on that day, a path in a property a link to that note', async () => {
  const e = await fresh(memFS({
    'recipes/rye.md': '---\nbaked: 2026-11-09\nsuperseded_by: rye-2.md\nsources:\n  - resource: ../notes/flour.md\n---\nOld rye.\n',
    'recipes/rye-2.md': 'New rye.\n', 'notes/flour.md': 'Flour.\n',
  }));
  const lines = async (title: string) => { const r = await e.query(title); await e.lines(r.backlinks.map((b) => ({ path: b.path, lines: b.lines.map((l) => l.line) }))).then((t) => r.backlinks.forEach((b, i) => t[i]?.forEach((x, j) => { b.lines[j].text = x.text; }))); return r.backlinks.map((b) => [b.path, b.lines.map((l) => l.text)]); };
  assert.deepEqual(await lines('November 9th, 2026'), [['recipes/rye.md', ['baked:: [[November 9th, 2026]]']]]);
  assert.deepEqual(await lines('rye-2'), [['recipes/rye.md', ['superseded_by:: [rye-2.md](rye-2.md)']]]);
  assert.deepEqual(await lines('flour'), [['recipes/rye.md', ['resource: [../notes/flour.md](../notes/flour.md)']]]);
});
