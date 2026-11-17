// Similar-name matching runs on the vault's SQLite database (src/sql/fuzzy.ts); when SQLite can't
// load, the in-memory index (src/core/fuzzy-index.ts) stands in. Every behaviour is checked on both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osaDistance, similarity, wordsAlign, foldKey, fuzzyKey, judge, diffMarks } from '../src/core/fuzzy.ts';
import { FuzzyIndex, ALIAS } from '../src/core/fuzzy-index.ts';
import { FuzzyTitles } from '../src/sql/fuzzy.ts';
import { VaultIndex, toNote } from '../src/core/vault-index.ts';
import { SqlIndex } from '../src/sql/sql-index.ts';
import { openDb } from '../src/sql/db.ts';
import { parseNote } from '../src/core/parser.ts';
import { VaultEngine } from '../src/engine.ts';

type Hit = { path: string; kind: number; sim: number; score: number };
const fm = (aliases?: string[]) => (aliases?.length ? `---\naliases: [${aliases.map((a) => JSON.stringify(a)).join(', ')}]\n---\n` : '');
const KINDS = ['sqlite', 'memory'] as const;
let dbs = 0;
async function store(kind: typeof KINDS[number], files: [string, string[]?][]) {
  const idx = kind === 'sqlite' ? new SqlIndex((await openDb('fuzzy-test-' + dbs++)).db) : new VaultIndex();
  idx.build(files.filter(([p]) => /\.md$/i.test(p)).map(([p, a]) => toNote(parseNote(p, fm(a)))), files.filter(([p]) => !/\.md$/i.test(p)).map(([p]) => p));
  const fx = kind === 'memory' ? new FuzzyIndex(idx) : null;
  return { idx, match: (t: string): Hit[] => fx ? fx.match(t, 10) : idx.fuzzy(t, 10)! };
}

const VAULT: [string, string[]?][] = [
  ['Recieve Window.md'],                   // typo in the vault
  ['Ridley Scott.md'],
  ['external-links.md'],
  ['Q4 Plan 2026.md'],
  ['Meeting Notes.md'],
  ['People/Ada Lovelace.md', ['Countess of Lovelace']],
  ['Café Culture.md'],
  ['🗂️ Plugins Overview.md'],
  ['Areas/12.04 Household Budget.md'],
  ['Photosynthesis.md'],
  ['Cats.md'],
  ['Owing.md'], ['Knowing.md'], ['Showing.md'], ['Growing.md'], ['Blowing.md'], ['Glowing.md'], ['Flowing.md'],
  ['image.png'],
];
for (const kind of KINDS) {
  const f = await store(kind, VAULT);
  const top = (t: string) => f.match(t)[0];

  test(`typos, transpositions, plurals and word order match (${kind})`, async () => {
    assert.equal(top('Receive Window')?.path, 'Recieve Window.md');
    assert.equal(top('Ridley Scot')?.path, 'Ridley Scott.md');
    assert.equal(top('Scott, Ridley')?.path, 'Ridley Scott.md');
    assert.equal(top('Meeting Note')?.path, 'Meeting Notes.md');
    assert.equal(top('Photosynthsis')?.path, 'Photosynthesis.md');
    assert.equal(top('Photosnythesis')?.path, 'Photosynthesis.md');  // two edits allowed in a 10+ letter word
    assert.equal(top('Owwing')?.path, 'Owing.md', 'a short key inside many longer ones still comes first');
  });

  test(`folding: case, diacritics, decoration and ID prefixes do not count as edits (${kind})`, async () => {
    assert.equal(top('cafe culturre')?.path, 'Café Culture.md');
    assert.equal(top('Plugin Overview')?.path, '🗂️ Plugins Overview.md');
    assert.equal(top('Houshold Budget')?.path, 'Areas/12.04 Household Budget.md');
  });

  test(`aliases are matched too, one hit per note (${kind})`, async () => {
    assert.deepEqual(f.match('Countess of Lovelace').map((h) => [h.path, h.sim]), [['People/Ada Lovelace.md', 1]]);
    const a = top('Countess of Lovelase');
    assert.deepEqual([a?.path, a?.kind], ['People/Ada Lovelace.md', ALIAS]);
  });

  test(`guards keep near-miss titles apart (${kind})`, async () => {
    assert.deepEqual(f.match('Q3 Plan 2026'), [], 'different digits');
    assert.deepEqual(f.match('Internal links'), [], 'one word, two edits');
    assert.deepEqual(f.match('Ridley Scott films'), [], 'different word count');
    assert.deepEqual(f.match('Cats'), [], 'under five characters');
    assert.deepEqual(f.match('Bats'), []);
    assert.deepEqual(f.match('Quantum Gardening'), []);
    assert.deepEqual(f.match('Ridley Scott').map((h) => h.path), ['Ridley Scott.md'], 'an exact name is the top of the band; the caller drops it');
    assert.deepEqual(f.match('   '), []);
    assert.deepEqual(f.match('image'), [], 'attachments are not notes');
  });

  test(`scores sit in the weak band, closer is higher (${kind})`, async () => {
    const same = top('photosynthesis?')!, one = top('Photosynthsis')!, two = top('Photosnythesis')!;
    assert.deepEqual([same.sim, same.score], [1, 0.55], 'punctuation and case only: same key');
    assert.ok(one.score >= 0.3 && one.score <= 0.55);
    assert.ok(one.score >= two.score);
  });

  test(`incremental: notes added, changed, moved and removed (${kind})`, async () => {
    const g = await store(kind, VAULT), idx = g.idx;
    const put = (p: string, aliases?: string[]) => idx.upsertNote(toNote(parseNote(p, fm(aliases))));
    assert.equal(g.match('Zebra Crosing').length, 0);
    put('Zebra Crossing.md');
    assert.equal(g.match('Zebra Crosing')[0]?.path, 'Zebra Crossing.md');
    put('Zebra Crossing.md', ['Pedestrian Crossing']);
    assert.equal(g.match('Pedestrain Crossing')[0]?.path, 'Zebra Crossing.md');
    put('Zebra Crossing.md', ['Crosswalk']);
    assert.equal(g.match('Pedestrain Crossing').length, 0, 'an alias taken away no longer matches');
    idx.removeFile('Zebra Crossing.md');
    put('Roads/Zebra Crossing.md');
    assert.deepEqual(g.match('Zebra Crosing').map((h) => h.path), ['Roads/Zebra Crossing.md']);
    assert.ok(idx.moveNote('Roads/Zebra Crossing.md', 'Streets/Zebra Crossing.md'));
    assert.deepEqual(g.match('Zebra Crosing').map((h) => h.path), ['Streets/Zebra Crossing.md']);
    idx.removeFile('Streets/Zebra Crossing.md');
    assert.equal(g.match('Zebra Crosing').length, 0);
    assert.equal(g.match('Crosswalks').length, 0);
    if (!(idx instanceof SqlIndex)) return;
    // The trigram counts stay right through all of that, match a fresh build(), and empty out.
    const db = (idx as any).db, counts = () => ['fuzzy_name', 'fuzzy_tri', 'fuzzy_gram'].map((t) => db.selectValue(`SELECT count(*) FROM ${t}`));
    const wrong = () => db.selectArrays('SELECT g, n FROM fuzzy_gram EXCEPT SELECT g, count(*) FROM fuzzy_tri GROUP BY g');
    idx.flush();
    assert.deepEqual(wrong(), []);
    const before = counts();
    new FuzzyTitles(db).build(db.selectArrays('SELECT f.id, f.path, n.aliases FROM files f JOIN notes n ON n.id = f.id').map(([id, path, a]: any) => ({ id, path, aliases: JSON.parse(a) })));
    assert.deepEqual(counts(), before);
    assert.deepEqual(wrong(), []);
    for (const [p] of VAULT) idx.removeFile(p);
    idx.flush();
    assert.deepEqual(counts(), [0, 0, 0]);
  });

  test(`quotes and apostrophes (${kind})`, async () => {
    const g = await store(kind, [['He said "hello world".md'], ["Don't Panic Now.md"]]);
    assert.equal(g.match('He said "helo world"')[0]?.path, 'He said "hello world".md');
    assert.equal(g.match('Dont Panic Now')[0]?.path, "Don't Panic Now.md");
  });
}

test('primitives', () => {
  assert.equal(osaDistance('recieve', 'receive'), 1);
  assert.equal(osaDistance('kitten', 'sitting'), 3);
  assert.equal(osaDistance('🙂a', 'a🙂'), 1);
  assert.equal(similarity('ridley scott', 'scott ridley'), 0.95);
  assert.ok(wordsAlign('recieve window', 'receive window'));
  assert.ok(!wordsAlign('internal links', 'external links'));
  assert.equal(foldKey('Ｃａｆé – “Quotes”'), 'cafe - quotes');
  assert.equal(fuzzyKey('🗂️ Plugins!'), 'plugins');
  assert.equal(judge('abcd', 'abcd'), null);
  assert.equal(judge('abcde', 'abcde')?.score, 0.55);
});

for (const kind of KINDS) test(`page results: close names only under a page no note is, and never a note already shown (${kind})`, async () => {
  const files: Record<string, string> = {
    'Recieve Window.md': 'flow control',
    'Receive Windows.md': '',
    'Notes/Linker.md': 'see [[Receive Window]]',
    'Meeting Notes.md': '', 'Meeting Note.md': '',
  };
  const fs = {
    async list() { return Object.entries(files).map(([path, t]) => ({ path, size: t.length, mtime: 1 })); },
    async readText(p: string) { return files[p]; },
    async stat(p: string) { return p in files ? { path: p, size: files[p].length, mtime: 1 } : null; },
  };
  const e = new VaultEngine(fs as any, ['YYYY-MM-DD'], kind === 'sqlite' ? new SqlIndex((await openDb('fuzzy-engine')).db) : null);
  await e.build();
  const r = await e.query('Receive Window');
  assert.deepEqual(r.counterparts, []);
  assert.deepEqual(r.backlinks.map((b) => b.path), ['Notes/Linker.md']);
  assert.deepEqual(r.fuzzy.map((f) => [f.path, f.marks]).sort(), [['Receive Windows.md', [14, 15]], ['Recieve Window.md', [3, 5]]]);
  assert.deepEqual((await e.query('Meeting Notes')).fuzzy, [], 'a page with a matching note gets no close names');
});

test('marks: the letters of a name that differ from the title', () => {
  const show = (n: string, t: string) => { let o = '', at = 0; for (const [a, b] of diffMarks(n, t)) { o += n.slice(at, a) + '[' + n.slice(a, b) + ']'; at = b; } return o + n.slice(at); };
  assert.equal(show('Workflwos', 'Workflows'), 'Workfl[wo]s');
  assert.equal(show('Recieve Window', 'Receive Window'), 'Rec[ie]ve Window');
  assert.equal(show('Meeting Notes', 'Meeting Note'), 'Meeting Note[s]');
  assert.equal(show('Workflow', 'Workflows'), 'Workflow', 'a letter the name lacks has nothing to mark');
  assert.equal(show('Ridley Scott', 'Scott, Ridley'), 'Ridley Scott', 'word order is not marked');
  assert.equal(show("Don't Panic Now", 'Dont Panic Now'), "Don't Panic Now", 'punctuation is not marked');
  assert.equal(show('Café Culture', 'cafe culture'), 'Café Culture', 'case and accents are not marked');
  assert.equal(show('🗂️ Plugin Overveiw', 'Plugins Overview'), '🗂️ Plugin Overv[ei]w');
});
