import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote } from '../src/core/parser.ts';
import { VaultIndex } from '../src/core/vault-index.ts';
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
  const want = ['prop:Beta', 'prop:Ridley Scott', 'prop:Unquoted', 'wiki:Target', 'wiki:Target', 'wiki:Target#Heading', 'wiki:Target#^abc123', 'wiki:#Local heading',
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

test('resolver: case-insensitive, path-qualified, duplicates, attachments, incremental', () => {
  const idx = new VaultIndex();
  const notes = [
    parseNote('A/Note.md', 'link [[note]] [[B/Note]] [[Missing]] ![[pic.png]] [[Other.md]]'),
    parseNote('B/Note.md', '[[Note]]'),
    parseNote('Other.md', '[[a/note]] [x](./A/Note.md)'),
  ];
  idx.build(notes, ['assets/pic.png']);
  const out = idx.outgoing.get('A/Note.md')!.map((r) => r.resolved);
  assert.deepEqual(out, ['A/Note.md', 'B/Note.md', null, 'assets/pic.png', 'Other.md']);
  assert.equal(idx.outgoing.get('B/Note.md')![0].resolved, 'B/Note.md'); // same folder wins
  assert.deepEqual(idx.outgoing.get('Other.md')!.map((r) => r.resolved), ['A/Note.md', 'A/Note.md']);
  assert.equal(idx.unresolved.get('missing')!.size, 1);
  const n = idx.upsertNote(parseNote('Z/Missing.md', 'hi'));
  assert.equal(n, 1);
  assert.equal(idx.unresolved.get('missing'), undefined);
  assert.equal(idx.backlinks.get('Z/Missing.md')!.size, 1);
  idx.removeFile('Z/Missing.md');
  assert.equal(idx.unresolved.get('missing')!.size, 1);
});

test('dates', () => {
  assert.equal(roamDailyToIso('November 5th, 2026'), '2026-11-05');
  assert.equal(roamDailyToIso('February 30th, 2026'), null);
  assert.equal(parseWithFormat('Journal/2026/11/2026-11-05', compileFormat('YYYY/MM/YYYY-MM-DD')), '2026-11-05');
  assert.equal(parseWithFormat('Thursday, November 5th 2026', compileFormat('dddd, MMMM Do YYYY')), '2026-11-05');
  assert.equal(formatIso('2026-11-05', 'DD.MM.YYYY'), '05.11.2026');
});

test('matcher tiers', () => {
  const idx = new VaultIndex();
  idx.build([
    parseNote('Projects/Alpha.md', '---\naliases: [Alpha Project]\n---\n'),
    parseNote('What is X.md', ''),
    parseNote('Daily/2026-11-05.md', 'met [[Ridley Scott]] about [[Projects/Alpha]] and [[What is X?]] #project-alpha'),
    parseNote('Projects-Beta.md', ''),
    parseNote('café.md', ''),
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
