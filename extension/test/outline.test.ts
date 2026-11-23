import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextOf, kidsAt, lineOfSub, MAX_KIDS } from '../src/core/outline.ts';

// A page as Roam's Markdown export writes it: "- " blocks, four spaces a level.
const day = [
  '- Morning',                                         // 0
  '    - Call with [[Harbour Cafe]]',                  // 1
  '        - they want [[Sourdough]] twice a week',    // 2
  '            - 40 loaves',                           // 3
  '            - delivery by 7',                       // 4
  '        - price list by Friday',                    // 5
  '    - Oven service',                                // 6
  '- Evening',                                         // 7
  '    - a block of',                                  // 8
  '      two lines about [[Sourdough]]',               // 9
  '        - under it',                                // 10
  '    - ```javascript',                               // 11
  '      - not a block [[Sourdough]]',                 // 12
  '      ```',                                         // 13
  '',
].join('\n');
const tree = (b: { text: string; kids: any[] }): any => (b.kids.length ? [b.text, b.kids.map(tree)] : b.text);

test('a line of a Roam export has its parent blocks above it and its children under it', () => {
  const [c] = contextOf(day, [2]);
  assert.equal(c.text, 'they want [[Sourdough]] twice a week');
  assert.deepEqual(c.up.map((u) => [u.line, u.text]), [[0, 'Morning'], [1, 'Call with [[Harbour Cafe]]']]);
  assert.deepEqual(c.kids.map(tree), ['40 loaves', 'delivery by 7']);
  const [top, leaf] = contextOf(day, [0, 4]);
  assert.deepEqual(top.up, []);
  assert.deepEqual(top.kids.map(tree), [['Call with [[Harbour Cafe]]', [['they want [[Sourdough]] twice a week', ['40 loaves', 'delivery by 7']], 'price list by Friday']], 'Oven service']);
  assert.deepEqual(leaf.up.map((u) => u.text), ['Morning', 'Call with [[Harbour Cafe]]', 'they want [[Sourdough]] twice a week']);
  assert.deepEqual(leaf.kids, []);
});

test('a line that continues a block gives the whole block', () => {
  const [c] = contextOf(day, [9]);
  assert.equal(c.line, 8);
  assert.equal(c.text, 'a block of\ntwo lines about [[Sourdough]]');
  assert.deepEqual(c.up.map((u) => u.text), ['Evening']);
  assert.deepEqual(c.kids.map(tree), ['under it']);
});

test('a list marker inside a code block starts no block', () => {
  const [c] = contextOf(day, [12]);
  assert.equal(c.line, 11);
  assert.equal(c.text, '```javascript\n- not a block [[Sourdough]]\n```');
  assert.deepEqual(c.up.map((u) => u.text), ['Evening']);
});

test('tabs, two spaces and other markers nest the same way', () => {
  const tabs = '- a\n\t- b\n\t\t- c [[X]]\n';
  const two = '* a\n  * b\n    1. c [[X]]\n';
  for (const t of [tabs, two]) assert.deepEqual(contextOf(t, [2])[0].up.map((u) => u.text), ['a', 'b']);
});

test('headings are parents of what follows them', () => {
  const note = '---\ntitle: x\n---\n# Plan\nintro [[X]]\n## Week one\n- buy flour\n    - [[X]] rye\n### Notes\ntext\n## Week two\npara [[X]]\n';
  const [intro, rye, para] = contextOf(note, [4, 7, 11]);
  assert.deepEqual([intro.text, intro.up.map((u) => u.text)], ['intro [[X]]', ['Plan']]);
  assert.deepEqual([rye.text, rye.up.map((u) => u.text)], ['[[X]] rye', ['Plan', 'Week one', 'buy flour']]);
  assert.deepEqual(para.up.map((u) => u.text), ['Plan', 'Week two']);
  assert.deepEqual(contextOf(note, [5])[0].up.map((u) => u.text), ['Plan']);
});

test('a paragraph at the margin ends the list above it', () => {
  const note = '- a\n    - b\n\nplain\n    - c [[X]]\n';
  assert.deepEqual(contextOf(note, [4])[0].up, []);
  assert.deepEqual(contextOf(note, [0])[0].kids.map(tree), ['b']);
});

test('a block with very many blocks under it comes cut, and kidsAt reads them all', () => {
  const big = '- top [[X]]\n' + Array.from({ length: MAX_KIDS + 50 }, (_, i) => `    - kid ${i}\n`).join('');
  const [c] = contextOf(big, [0]);
  assert.equal(c.kids.length, MAX_KIDS);
  assert.equal(c.cut, true);
  assert.equal(kidsAt(big, 0).length, MAX_KIDS + 50);
});

test('odd input: an empty note, a line past the end, Windows line ends, rules', () => {
  assert.deepEqual(contextOf('', [0, 5]).map((c) => c.text), ['', '']);
  assert.equal(contextOf('- a\r\n    - b [[X]]\r\n', [1])[0].up[0].text, 'a');
  assert.deepEqual(contextOf('- a\n---\n* * *\n    - b\n', [3])[0].up, []);
});

import { outlineOf } from '../src/core/outline.ts';

test('a whole note becomes an outline: properties, headings with what follows them, lists, paragraphs, code', () => {
  const note = [
    '---', 'aliases: [Levain]', 'tags:', '  - bread', '  - starter', '---',
    '# Sourdough', 'A wild yeast bread.', 'Second line of the paragraph.', '',
    '## Method', '- Mix', '\t- flour and [[Water]]', '\t\t- 75% hydration', '- Fold', '',
    '```', '- not a block', '```', '', '> a quote', '> of two lines', '',
    '## Notes', 'last words',
  ].join('\n');
  assert.deepEqual(outlineOf(note).map(tree), [
    'aliases:: Levain',
    ['tags::', ['#bread', '#starter']],
    ['# Sourdough', [
      'A wild yeast bread. Second line of the paragraph.',
      ['## Method', [['Mix', [['flour and [[Water]]', ['75% hydration']]]], 'Fold', '```\n- not a block\n```', '> a quote\n> of two lines']],
      ['## Notes', ['last words']],
    ]],
  ]);
  assert.deepEqual(outlineOf(day).map(tree)[0], contextOf(day, [0]).map(tree)[0]);
  assert.deepEqual(outlineOf(''), []);
});

test('a paragraph wrapped over several lines is one block, whichever line is asked for', () => {
  const md = 'Intro line\n\nThe starter is fed\nwith [[Rye]] flour  \nand kept at 26°.\n\n| a | b |\n| - | - |\n| [[Rye]] | 2 |\n';
  const [c] = contextOf(md, [3]);
  assert.equal(c.text, 'The starter is fed with [[Rye]] flour\nand kept at 26°.');
  assert.equal(c.line, 2);
  assert.equal(contextOf(md, [8])[0].text, '| a | b |\n| - | - |\n| [[Rye]] | 2 |');
});

test('a line of a paragraph too long to show is shown alone', () => {
  const md = 'y'.repeat(5000) + '\n[[Rye]] at the end';
  const [c] = contextOf(md, [1]);
  assert.equal(c.text, '[[Rye]] at the end');
  assert.equal(c.line, 1);
});

test('a heading comes with what it owns, up to the next heading of its level', () => {
  const md = '## 2026-11-21\n\n- Added the rye loaf\n    - by Ines\n\nA note.\n\n### Later\n\n- More\n\n## 2026-11-20\n\n- First entries\n';
  const [c] = contextOf(md, [0]);
  assert.equal(c.text, '2026-11-21');
  assert.deepEqual(c.kids.map((k) => k.text), ['Added the rye loaf', 'A note.', '### Later']);
  assert.deepEqual(c.kids[0].kids.map((k) => k.text), ['by Ines']);
  assert.deepEqual(c.kids[2].kids.map((k) => k.text), ['More']);
});

test('the line a link names: a heading by its text, a block by its id', () => {
  const note = ['# Dark rye', '', '## Mix & fold', '- fold four times ^fold', '- rest', '', 'Bake hot, with steam.', '^bake', '', '### Proof'].join('\n');
  assert.equal(lineOfSub(note, '#Mix & fold'), 2);
  assert.equal(lineOfSub(note, '#mix fold'), 2); // letter case and punctuation don't count, as in Obsidian
  assert.equal(lineOfSub(note, '#Mix & fold#Proof'), 9);
  assert.equal(lineOfSub(note, '#^fold'), 3);
  assert.equal(lineOfSub(note, '#^bake'), 6); // an id on its own line names the block above it
  assert.equal(lineOfSub(note, '#Shape'), undefined);
  assert.equal(lineOfSub(note, '#^fol'), undefined);
  assert.equal(lineOfSub(note, '#'), undefined);
});

test('properties are attributes as Roam would hold them: no quotes, tags, dates as days, paths as links', () => {
  const note = ['---', 'title: "Dark rye"', 'tags: [bread, rye]', 'baked: 2026-11-09', 'related: "[[Sourdough]]"', 'superseded_by: ../recipes/rye-2.md',
    'sources:', '  - resource: notes/flour.md', '    note: \'from the mill\'', '  - "[[Mill]]"', 'servings: 12', 'draft: true', '---', 'Body.'].join('\n');
  assert.deepEqual(outlineOf(note).map(tree), [
    'title:: Dark rye', 'tags:: #bread #rye', 'baked:: [[November 9th, 2026]]', 'related:: [[Sourdough]]', 'superseded_by:: [../recipes/rye-2.md](../recipes/rye-2.md)',
    ['sources::', ['resource: [notes/flour.md](notes/flour.md)', 'note: from the mill', '[[Mill]]']], 'servings:: 12', 'draft:: true', 'Body.',
  ]);
  // a line of the frontmatter that links: its attribute block, a value in a list under its property
  const [rel, src, body] = contextOf(note, [4, 7, 13]);
  assert.deepEqual([rel.text, rel.up], ['related:: [[Sourdough]]', []]);
  assert.deepEqual([src.text, src.up], ['resource: [notes/flour.md](notes/flour.md)', [{ text: 'sources::', line: 6 }]]);
  assert.equal(body.text, 'Body.');
});

test('items of a numbered list carry their numbers, counted as Markdown counts them', () => {
  const nums = (b: any): any => (b.kids.length ? [b.n ?? '-', b.kids.map(nums)] : b.n ?? '-');
  const note = ['Steps', '', '1. Mix', '1. Fold', '    - gently', '    3. twice', '    3. thrice', '7) Bake', '- Cool', '4. Eat', '', '^steps'].join('\n');
  assert.deepEqual(outlineOf(note).map(nums), ['-', 1, [2, ['-', 3, 4]], 3, '-', 4]);
  assert.deepEqual(kidsAt(note, 3).map((k) => k.n), [undefined, 3, 4]);
  assert.deepEqual(contextOf(note, [3])[0].kids.map((k) => k.n), [undefined, 3, 4]);
  assert.equal(outlineOf(note).some((b) => b.text.includes('^steps')), false); // a line that is only an id is no block
});

test('OKF: type and status are pages in a bundle, plain words elsewhere', () => {
  const note = '---\ntype: BigQuery Table\nstatus: draft\nkind: thing\n---\nbody\n';
  assert.deepEqual(outlineOf(note, true).slice(0, 3).map((b) => b.text), ['type:: [[BigQuery Table]]', 'status:: [[draft]]', 'kind:: thing']);
  assert.deepEqual(outlineOf(note).slice(0, 2).map((b) => b.text), ['type:: BigQuery Table', 'status:: draft']);
  assert.equal(contextOf(note, [1], true)[0].text, 'type:: [[BigQuery Table]]');
});

test('reference-style links read as the inline links they stand for; their definitions are hidden', async () => {
  const { outlineOf } = await import('../src/core/outline.ts');
  const text = [
    '# Suppliers',                                           // 0
    '',                                                      // 1
    'Flour from [the mill][mill], rye from [Rye Farm][].',   // 2
    '- ask [Mill] about spelt, not `[mill]` in code',        // 3
    '- [ ] a task, [[Oven]] and [x](y.md) as they were',     // 4
    '',                                                      // 5
    '[mill]: Suppliers/Stone%20Mill.md "the mill"',          // 6
    '[rye farm]: <Rye Farm.md>',                             // 7
  ].join('\n');
  const o = outlineOf(text);
  assert.equal(o.length, 1);
  assert.deepEqual(o[0].kids.map((k) => k.text), [
    'Flour from [the mill](Suppliers/Stone%20Mill.md), rye from [Rye Farm](<Rye Farm.md>).',
    'ask [Mill](Suppliers/Stone%20Mill.md) about spelt, not `[mill]` in code',
    '[ ] a task, [[Oven]] and [x](y.md) as they were',
  ]);
  const { parseNote } = await import('../src/core/parser.ts');
  const links = parseNote('Notes.md', text).links.filter((l) => l.kind === 'md').map((l) => [l.target, l.line, l.display]);
  assert.deepEqual(links.sort((a, b) => +a[1]! - +b[1]!), [
    ['y.md', 4, 'x'],
    ['Suppliers/Stone Mill.md', 2, 'the mill'],
    ['Rye Farm.md', 2, 'Rye Farm'],
    ['Suppliers/Stone Mill.md', 3, 'Mill'],
  ].sort((a, b) => +a[1]! - +b[1]!));
});

test('a footnote is a block of its own text, and a link to it finds its line', async () => {
  const { outlineOf } = await import('../src/core/outline.ts');
  const text = 'Rye proves slower[^rye].\n\n[^rye]: Keep it at 26°.\n[^2]: Second note.\n';
  assert.deepEqual(outlineOf(text).map((b) => b.text), ['Rye proves slower[^rye].', 'Keep it at 26°.', 'Second note.']);
  assert.equal(lineOfSub(text, '#[^rye]'), 2);
  assert.equal(lineOfSub(text, '#[^2]'), 3);
  assert.equal(lineOfSub(text, '#[^none]'), undefined);
});
