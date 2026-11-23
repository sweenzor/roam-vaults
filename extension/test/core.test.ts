import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote } from '../src/core/parser.ts';
import { VaultIndex, toNote } from '../src/core/vault-index.ts';
import { RoamMatcher } from '../src/core/matcher.ts';
import { roamDailyToIso, compileFormat, parseWithFormat, formatIso } from '../src/core/dates.ts';

const doc = `---
aliases:
  - Alpha Project
  - "What is X?"
tags: [project, "area/work"]
related: "[[Beta]]"
people:
  - "[[Ridley Scott]]"
bad: [[Unquoted]]
# comment [[NotALink]]
---
# Title
See [[Target]], [[Target|alias]], [[Target#Heading]], [[Target#^abc123]], [[#Local heading]].
Embeds: ![[Note]] ![[image.png|100]] ![[Board.canvas]] ![[Daily.base]]
Markdown: [x](Target.md) [y](Target%20Name.md) [z](<Target Name.md>) [r](../up/Rel.md#Sec) [e](https://ex.com/a.md) ![img](pics/a%20b.png)
Inline \`[[NotLink1]]\` and \`\`code with \` [[NotLink2]]\`\` and %%[[NotLink3]]%% and <!-- [[NotLink4]] -->.
| a | [[Table\\|Shown]] |
Tags: #tag #nested/tag #1984 #y1984 not#tag (#paren) #émoji🙂 [[Note#Heading]] http://x.com/#frag
  [[  Spaced  ]] [[Café]] text ^block-1
\`\`\`js
[[NotLink5]] #notatag
\`\`\`
~~~~
[[NotLink6]]
~~~~
> \`\`\`
> [[NotLink7]]
> \`\`\`
%%
multi-line [[NotLink8]]
%%
$$
[[NotLink9]]
$$
\\[[Escaped]]
last [[Final]]
`;

test('parser extracts expected links and skips code/comments', () => {
  const n = parseNote('folder/My Note.md', doc, { snippets: true });
  const targets = n.links.map((l) => `${l.kind}${l.embed ? '!' : ''}:${l.target}${l.subpath}`);
  for (const t of targets) assert.ok(!/NotLink/.test(t), 'leaked ' + t);
  assert.deepEqual(n.aliases, ['Alpha Project', 'What is X?']);
  assert.ok(n.tags.includes('project') && n.tags.includes('area/work') && n.tags.includes('tag') && n.tags.includes('nested/tag'));
  assert.ok(n.tags.includes('y1984') && !n.tags.includes('1984'));
  assert.ok(n.tags.includes('émoji🙂'));
  assert.ok(!n.tags.includes('notatag'));
  const want = ['prop:related', 'prop:people', 'prop:bad', 'prop:Beta', 'prop:Ridley Scott', 'prop:Unquoted', 'wiki:Target', 'wiki:Target', 'wiki:Target#Heading', 'wiki:Target#^abc123', 'wiki:#Local heading',
    'wiki!:Note', 'wiki!:image.png', 'wiki!:Board.canvas', 'wiki!:Daily.base', 'wiki:Table', 'wiki:Note#Heading', 'wiki:Spaced', 'wiki:Café', 'wiki:Final',
    'md:Target.md', 'md:Target Name.md', 'md:Target Name.md', 'md:../up/Rel.md#Sec', 'md!:pics/a b.png'];
  // escaped \[[Escaped]] : we keep it (Obsidian renders it as a link too) – document
  assert.deepEqual(targets.filter((t) => !t.includes('Escaped')).sort(), want.sort());
  assert.deepEqual(n.blockIds, ['block-1']);
  const tbl = n.links.find((l) => l.target === 'Table')!;
  assert.equal(tbl.display, 'Shown');
  assert.ok(n.links.find((l) => l.target === 'Spaced')!.flags & 1);
  assert.ok(n.headings[0].text === 'Title');
});

const note = (path: string, text: string) => toNote(parseNote(path, text));

test('the index keeps a note as its path, aliases, tags and link targets with their lines', () => {
  const n = toNote(parseNote('folder/My Note.md', doc), 123, 456);
  assert.deepEqual(Object.keys(n).sort(), ['aliases', 'links', 'mtime', 'path', 'size', 'tags']);
  assert.deepEqual([n.path, n.size, n.mtime], ['folder/My Note.md', 123, 456]);
  assert.deepEqual(n.aliases, ['Alpha Project', 'What is X?']);
  const at = (target: string) => { const i = n.links.indexOf(target); return i < 0 ? undefined : n.links[i + 1]; };
  assert.equal(at('Beta'), 5 * 2);          // frontmatter link on line 5
  assert.equal(at('Note'), 13 * 2 + 1);     // ![[Note]] is an embed on line 13
  assert.ok(!n.links.includes(''), 'links to the note itself are left out');
  assert.equal(n.links.length % 2, 0);
});

test('resolver: case-insensitive, path-qualified, duplicates, attachments, incremental', () => {
  const idx = new VaultIndex();
  const notes = [
    note('A/Note.md', 'link [[note]] [[B/Note]] [[Missing]] ![[pic.png]] [[Other.md]]'),
    note('B/Note.md', '[[Note]]'),
    note('Other.md', '[[a/note]] [x](./A/Note.md)'),
  ];
  idx.build(notes, ['assets/pic.png']);
  assert.deepEqual(idx.outgoing('A/Note.md'), ['A/Note.md', 'B/Note.md', null, 'assets/pic.png', 'Other.md']);
  assert.deepEqual(idx.outgoing('B/Note.md'), ['B/Note.md']); // same folder wins
  assert.deepEqual(idx.outgoing('Other.md'), ['A/Note.md', 'A/Note.md']);
  assert.deepEqual(idx.backlinks(['A/Note.md']).map((h) => [h.src, h.line, h.embed]), [['Other.md', 0, false], ['Other.md', 0, false]]);
  assert.deepEqual(idx.backlinks(['assets/pic.png']).map((h) => [h.src, h.embed]), [['A/Note.md', true]]);
  assert.deepEqual(idx.unresolved('missing').map((h) => h.src), ['A/Note.md']);
  idx.upsertNote(note('Z/Missing.md', 'hi'));
  assert.equal(idx.unresolved('missing').length, 0);
  assert.deepEqual(idx.backlinks(['Z/Missing.md']).map((h) => h.src), ['A/Note.md']);
  idx.removeFile('Z/Missing.md');
  assert.equal(idx.unresolved('missing').length, 1);
  assert.equal(idx.backlinks(['Z/Missing.md']).length, 0);
  // an edited note stops counting for the links it no longer has
  idx.upsertNote(note('A/Note.md', 'only [[Other]] now'));
  assert.equal(idx.unresolved('missing').length, 0);
  assert.deepEqual(idx.backlinks(['Other.md']).map((h) => h.src), ['A/Note.md']);
  assert.ok(!idx.linkers.has('missing') && !idx.linkers.has('pic.png'));
});

test('dates', () => {
  assert.equal(roamDailyToIso('November 5th, 2026'), '2026-11-05');
  assert.equal(roamDailyToIso('February 30th, 2026'), null);
  assert.equal(parseWithFormat('Journal/2026/11/2026-11-05', compileFormat('YYYY/MM/YYYY-MM-DD')), '2026-11-05');
  assert.equal(parseWithFormat('Thursday, November 5th 2026', compileFormat('dddd, MMMM Do YYYY')), '2026-11-05');
  assert.equal(formatIso('2026-11-05', 'DD.MM.YYYY'), '05.11.2026');
});

test('a date format with an unclosed [ is read literally instead of looping forever', () => {
  assert.equal(parseWithFormat('Journal/2026-11-05 [draft', compileFormat('YYYY-MM-DD [draft')), '2026-11-05');
  assert.equal(formatIso('2026-11-05', 'YYYY-MM-DD [draft'), '2026-11-05 [draft');
  // closed brackets still mean literal text
  assert.equal(parseWithFormat('Daily 2026-11-05', compileFormat('[Daily] YYYY-MM-DD')), '2026-11-05');
  assert.equal(formatIso('2026-11-05', '[Daily] YYYY-MM-DD'), 'Daily 2026-11-05');
});

test('matcher tiers', () => {
  const idx = new VaultIndex();
  idx.build([
    note('Projects/Alpha.md', '---\naliases: [Alpha Project]\n---\n'),
    note('What is X.md', ''),
    note('Daily/2026-11-05.md', 'met [[Ridley Scott]] about [[Projects/Alpha]] and [[What is X?]] #project-alpha'),
    note('Projects-Beta.md', ''),
    note('café.md', ''),
  ], []);
  const m = new RoamMatcher(idx, { dailyFormats: ['YYYY-MM-DD'] });
  const a = m.associations('Projects/Alpha');
  assert.deepEqual(a.notes, [{ path: 'Projects/Alpha.md', how: 'path' }]);
  assert.equal(a.links.length, 1);
  assert.equal(m.associations('Alpha Project').notes[0].how, 'alias');
  assert.equal(m.associations('November 5th, 2026').notes[0].path, 'Daily/2026-11-05.md');
  const x = m.associations('What is X?');
  assert.equal(x.notes[0].how, 'sanitized');
  assert.equal(x.links[0].via, 'unresolved');
  assert.equal(m.associations('Ridley Scott').links.length, 1);
  assert.equal(m.associations('Projects/Beta').notes[0].how, 'ns-flat');
  assert.equal(m.associations('Project Alpha').tagged.length, 1);
  assert.equal(m.associations('Café'.normalize('NFD')).notes[0].path, 'café.md');
});

test('frontmatter tags: a list gives its tags, a string one tag when it can be one, as Obsidian reads them', async () => {
  const { extractFmTags } = await import('../src/core/frontmatter.ts');
  assert.deepEqual(extractFmTags({ tags: ['bake', '#starter'] }), ['bake', 'starter']);
  assert.deepEqual(extractFmTags({ tags: 'bake' }), ['bake']);
  assert.deepEqual(extractFmTags({ tags: 'bake, pastry' }), []);
  assert.deepEqual(extractFmTags({ tag: 'bake pastry' }), []);
});

test('OKF: title names a note, index.md stands for its folder, a log\'s days are links to those days', () => {
  const idx = new VaultIndex();
  idx.build([
    note('index.md', '---\nokf_version: "0.3"\ntitle: Bakery\n---\n'),
    note('log.md', '## 2026-11-21\n\n- Added the rye loaf\n\n## 2026-11-20\n\n- First entries\n'),
    note('products/index.md', '## Breads\n'),
    note('products/country-sourdough.md', '---\ntitle: Country Sourdough Loaf\n---\nA wild yeast bread.\n'),
    note('suppliers/index.md', ''),
  ], []);
  const m = new RoamMatcher(idx, { dailyFormats: ['DD-MM-YYYY'] });
  assert.deepEqual(m.associations('Country Sourdough Loaf').notes, [{ path: 'products/country-sourdough.md', how: 'alias' }]);
  assert.deepEqual(m.associations('Products').notes, [{ path: 'products/index.md', how: 'path' }]);
  assert.deepEqual(m.associations('Index').notes, []);
  const day = m.associations('November 21st, 2026');
  assert.deepEqual(day.links.map((l) => [l.src, l.line]), [['log.md', 0]]);
});

test('a property\'s name is a page, in frontmatter and as Roam writes it in the body', () => {
  const n = parseNote('n.md', '---\nauthor: Ann\ntags: [a]\naliases: [b]\ncssclasses: wide\n---\n- Source:: a book\n    1. Rating:: 4\nNot an attribute: here\n`Code:: x`\n');
  assert.deepEqual(n.links.map((l) => [l.target, l.line]), [['author', 1], ['Source', 6], ['Rating', 7]]);
});
