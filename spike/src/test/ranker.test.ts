import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote } from '../core/parser.ts';
import { VaultIndex } from '../core/vault-index.ts';
import { NoteRanker, osaDistance, similarity, wordsAlign, foldKey, decorKey, type RankedNote } from '../core/ranker.ts';

// One vault holding every awkward title/filename pair we know about.
const FILES: [string, string][] = [
  ['Avatar.md', ''],                                    // case-only collision (hub: theme vs person)
  ['people/avatar.md', ''],
  ['en/Note.md', ''],                                   // duplicate basenames across languages
  ['de/Note.md', ''],
  ['What is X.md', ''],                                 // Roam "What is X?" ('?' is illegal in filenames)
  ['café.md', ''],
  ['Don\'t Panic.md', ''],                              // straight quote on disk, curly in Roam
  ['🗂️ Plugins.md', ''],                               // emoji-decorated filename
  ['Areas/12.04 Budget.md', ''],                        // Johnny.Decimal prefix
  ['Notetaking.md', ''],
  ['Recieve Window.md', ''],                            // typo in the vault
  ['Ridley Scott.md', ''],
  ['external-links.md', ''],
  ['Obsidian Publish.md', ''],
  ['Q4 Plan 2026.md', ''],
  ['C.md', ''],
  ['Book by Author.md', ''],                            // Roam "[[Book]] by [[Author]]"
  ['Projects/Alpha.md', '---\naliases: [Alpha Project]\n---\n'],
  ['Archive/Projects/Alpha.md', ''],
  ['Alpha.md', ''],                                     // leaf only: must never match "Projects/Alpha"
  ['pages/Projects___Beta.md', ''],                     // Logseq namespace encoding
  ['Projects-Gamma.md', ''],                            // flattened namespace
  ['tables/customers.md', '---\ntype: table\ntitle: Customer Table\n---\n'], // OKF title
  ['Daily/2026-11-05.md', ''],
  ['journals/2026_11_04.md', ''],
  ['R&D.md', ''],
  ['Ｆｕｌｌｗｉｄｔｈ.md', ''],
];

function setup() {
  const idx = new VaultIndex();
  idx.build(FILES.map(([p, c]) => parseNote(p, c)), ['assets/Avatar.png']);
  return { idx, r: new NoteRanker(idx, { dailyFormats: ['YYYY-MM-DD', 'YYYY_MM_DD'] }) };
}
const { idx, r } = setup();
const top = (t: string) => r.rank(t)[0];
const paths = (xs: RankedNote[]) => xs.map((x) => x.path);

test('exact case beats case-insensitive, without an ambiguity flag', () => {
  const res = r.rank('Avatar');
  assert.deepEqual(paths(res), ['Avatar.md', 'people/avatar.md']); // attachment Avatar.png never matches
  assert.equal(res[0].signal, 'exact'); assert.equal(res[0].score, 1);
  assert.equal(res[1].signal, 'case'); assert.equal(res[1].band, 'strong');
  assert.ok(!res[0].ambiguous && !res[1].ambiguous);
  assert.equal(top('avatar').path, 'people/avatar.md');
});

test('duplicate basenames are both strong and flagged ambiguous', () => {
  const res = r.rank('Note');
  assert.deepEqual(paths(res), ['de/Note.md', 'en/Note.md']);
  assert.ok(res.every((x) => x.score === 1 && x.ambiguous));
});

test('filename-illegal characters: sanitized tier is medium', () => {
  const x = top('What is X?');
  assert.deepEqual([x.path, x.signal, x.band], ['What is X.md', 'sanitized', 'medium']);
});

test('Unicode: NFD title, diacritics, curly quotes, fullwidth, ampersand', () => {
  assert.deepEqual([top('Café'.normalize('NFD')).path, top('Café'.normalize('NFD')).signal], ['café.md', 'case']);
  assert.deepEqual([top('Cafe').path, top('Cafe').signal], ['café.md', 'folded']);
  assert.deepEqual([top('Don’t Panic').path, top('Don’t Panic').signal], ["Don't Panic.md", 'folded']);
  assert.equal(top('Fullwidth').path, 'Ｆｕｌｌｗｉｄｔｈ.md');
  assert.equal(top('R and D').path, 'R&D.md');
  assert.equal(top('R&D').signal, 'exact');
});

test('decorated filenames: emoji and ID prefixes', () => {
  const p = top('Plugins');
  assert.deepEqual([p.path, p.signal, p.band], ['🗂️ Plugins.md', 'decorated', 'medium']);
  assert.deepEqual([top('Budget').path, top('Budget').signal], ['Areas/12.04 Budget.md', 'decorated']);
  assert.equal(decorKey('✅ Done ✨'), 'done');
  assert.equal(top('Obsidian Publish.').signal, 'decorated'); // trailing sentence punctuation
});

test('loose and fuzzy are weak suggestions only', () => {
  const l = top('Note-taking');
  assert.deepEqual([l.path, l.signal, l.band], ['Notetaking.md', 'loose', 'weak']);
  const f = top('Receive Window');
  assert.deepEqual([f.path, f.signal, f.band], ['Recieve Window.md', 'fuzzy', 'weak']);
  const o = top('Scott, Ridley');
  assert.deepEqual([o.path, o.signal], ['Ridley Scott.md', 'fuzzy']);
  assert.ok(o.score < 0.55 && o.score >= 0.3);
});

test('false-positive guards', () => {
  assert.deepEqual(r.rank('Q3 Plan 2026'), [], 'different digits never fuzz together');
  assert.deepEqual(r.rank('C#'), [], 'lossy tiers need 3+ characters');
  assert.deepEqual(r.rank('C++'), []);
  assert.deepEqual(r.rank('Cats'), [], 'no fuzzy on short titles');
  assert.deepEqual(r.rank('Quantum Gardening'), []);
  assert.deepEqual(r.rank('Internal links'), [], 'one word two edits apart is a different word');
  assert.deepEqual(r.rank('Ridley Scott films'), [], 'fuzzy needs the same word count');
  assert.deepEqual(r.rank('   '), []);
});

test('nested-link titles are capped at medium', () => {
  const b = top('[[Book]] by [[Author]]');
  assert.deepEqual([b.path, b.signal, b.score], ['Book by Author.md', 'sanitized', 0.6]);
});

test('namespaces: whole path > suffix; never the leaf alone; Logseq and flattened encodings', () => {
  const res = r.rank('Projects/Alpha');
  assert.deepEqual(paths(res), ['Projects/Alpha.md', 'Archive/Projects/Alpha.md']);
  assert.deepEqual(res.map((x) => x.score), [0.95, 0.9]);
  assert.ok(!res.some((x) => x.ambiguous));
  assert.equal(r.rank('projects/alpha')[0].score, 0.92); // case differs
  assert.deepEqual([top('Projects/Beta').path, top('Projects/Beta').signal, top('Projects/Beta').band], ['pages/Projects___Beta.md', 'ns-encoded', 'strong']);
  assert.deepEqual([top('Projects/Gamma').path, top('Projects/Gamma').signal, top('Projects/Gamma').band], ['Projects-Gamma.md', 'ns-flat', 'medium']);
});

test('aliases, frontmatter titles and daily notes', () => {
  assert.deepEqual([top('Alpha Project').signal, top('Alpha Project').score], ['alias', 0.93]);
  assert.equal(top('alpha project').score, 0.92);
  assert.deepEqual([top('Customer Table').path, top('Customer Table').signal], ['tables/customers.md', 'title']);
  assert.deepEqual([top('November 5th, 2026').path, top('November 5th, 2026').signal], ['Daily/2026-11-05.md', 'daily']);
  assert.equal(top('November 4th, 2026').path, 'journals/2026_11_04.md');
});

test('every signal that fired is kept as a reason, best first', () => {
  const idx2 = new VaultIndex();
  idx2.build([parseNote('What is Y.md', '---\naliases: ["What is Y?"]\n---\n')], []);
  const x = new NoteRanker(idx2).rank('What is Y?')[0];
  assert.equal(x.signal, 'alias');
  assert.deepEqual(x.reasons.map((y) => y.signal), ['alias', 'sanitized', 'folded', 'decorated', 'loose']);
});

test('incremental: add, update and remove notes', () => {
  const { idx: i2, r: r2 } = setup();
  assert.deepEqual(r2.rank('Zebra Crossing'), []);
  i2.upsertNote(parseNote('Zebra-Crossing.md', ''));
  assert.equal(r2.rank('Zebra Crossing')[0].signal, 'loose');
  i2.upsertNote(parseNote('Zebra-Crossing.md', '---\ntitle: Zebra Crossing\n---\n'));
  assert.equal(r2.rank('Zebra Crossing')[0].signal, 'title');
  i2.removeFile('Zebra-Crossing.md');
  assert.deepEqual(r2.rank('Zebra Crossing'), []);
  assert.equal(idx.notes.has('Zebra-Crossing.md'), false); // shared fixture untouched
});

test('options: limit, minScore, fuzzy off', () => {
  assert.equal(r.rank('Avatar', { limit: 1 }).length, 1);
  assert.deepEqual(r.rank('Note-taking', { minScore: 0.6 }), []);
  const { idx: i3 } = setup();
  assert.deepEqual(new NoteRanker(i3, { fuzzy: false }).rank('Receive Window'), []);
});

test('similarity primitives', () => {
  assert.equal(osaDistance('recieve', 'receive'), 1);
  assert.equal(osaDistance('', 'abc'), 3);
  assert.equal(osaDistance('kitten', 'sitting'), 3);
  assert.equal(osaDistance('🙂a', 'a🙂'), 1); // code points, not UTF-16 units
  assert.equal(similarity('ridley scott', 'scott ridley'), 0.95);
  assert.ok(wordsAlign('recieve window', 'receive window') && wordsAlign('scott ridley', 'ridley scott'));
  assert.ok(!wordsAlign('internal links', 'external links') && !wordsAlign('note taking', 'notetaking'));
  assert.equal(foldKey('Ｃａｆé – “Quotes”'), 'cafe - quotes');
});
