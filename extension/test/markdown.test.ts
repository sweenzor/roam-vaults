import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockBody } from '../src/main/markdown.ts';

// A stand-in for the few DOM calls the renderer makes, so it can run under Node.
class El {
  tag: string; kids: (El | string)[] = []; className = ''; dataset: Record<string, string> = {};
  style = { setProperty() {}, whiteSpace: '' };
  classList = { add: (c: string) => { this.className = `${this.className} ${c}`.trim(); } };
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: (El | string)[]) { this.kids.push(...nodes); }
  set textContent(t: string) { this.kids = [t]; }
  get textContent(): string { return this.kids.map((k) => (typeof k === 'string' ? k : k.textContent)).join(''); }
}
(globalThis as any).document = { createElement: (tag: string) => new El(tag), createDocumentFragment: () => new El('#fragment') };

const body = (text: string) => {
  const root = new El('div');
  const level = blockBody(root as unknown as HTMLElement, text);
  return [level, ...root.kids.map((k) => (typeof k === 'string' ? k : `${k.tag}${k.className ? '.' + k.className : ''}:${k.textContent}`))];
};

test('a block is a heading, a quote, a rule, text with code in it, or a line of text', () => {
  assert.deepEqual(body('## Method'), [2, 'Method']);
  assert.deepEqual(body('plain text'), [0, 'plain text']);
  assert.deepEqual(body('> quoted\n> twice'), [0, 'blockquote.rm-bq:quoted\ntwice']);
  assert.deepEqual(body('> [!tip] Keep the starter warm\n> near the oven'), [0, 'blockquote.rm-bq:Keep the starter warm\nnear the oven']);
  assert.deepEqual(body('> [!note]\n> text'), [0, 'blockquote.rm-bq:Note\ntext']);
  assert.deepEqual(body('---'), [0, 'hr.rm-hr:']);
  assert.deepEqual(body('```js\nlet a = [[1]];\n```'), [0, 'pre.rv-code:let a = [[1]];']);
  assert.deepEqual(body('before\n```\ncode\n```\nafter'), [0, 'span:before', 'pre.rv-code:code', 'span:after']);
});

// ---------- inline text, as Roam draws it ----------
import { inline } from '../src/main/markdown.ts';
/** The elements an inline string becomes: tag.class{target}:text, plain text as it is. */
const parts = (s: string) => {
  const root = new El('div');
  inline(root as unknown as HTMLElement, s);
  const one = (k: El | string): string => {
    if (typeof k === 'string') return k;
    const t = k.dataset.rvTarget ?? k.dataset.linkTitle;
    const inner = k.kids.some((x) => typeof x !== 'string') ? `(${k.kids.map(one).join('|')})` : k.textContent;
    return `<${k.tag}${k.className ? '.' + k.className.replace(/ /g, '.') : ''}${t !== undefined ? `{${t}}` : ''}:${inner}>`;
  };
  return root.kids.map(one);
};
const ref = (t: string, shown = t) => `<span{${t}}:(<span.rm-page-ref__brackets:[[>|<span.rm-page-ref.rm-page-ref--link{${t}}:${shown}>|<span.rm-page-ref__brackets:]]>)>`;

test('page links, aliases and tags are Roam\'s elements, from Roam\'s spelling and from Obsidian\'s', () => {
  assert.deepEqual(parts('see [[Dark rye]] now'), ['see ', ref('Dark rye'), ' now']);
  assert.deepEqual(parts('[Rye]([[Dark rye]])'), ['<a.rm-alias.rm-alias--page{Dark rye}:Rye>']);
  assert.deepEqual(parts('[[Dark rye|Rye]]'), ['<a.rm-alias.rm-alias--page{Dark rye}:Rye>']);
  assert.deepEqual(parts('[[Dark rye#Proof]]'), [ref('Dark rye', 'Dark rye > Proof')]);
  assert.deepEqual(parts('[[Dark rye#Method#Proof]]'), [ref('Dark rye', 'Dark rye > Method > Proof')]);
  assert.deepEqual(parts('[[#Proof]]'), [ref('', 'Proof')]);
  assert.deepEqual(parts('[[Dark rye#^fold]]'), ['<span.rm-block-ref.dont-focus-block{Dark rye}:(<span:Dark rye#^fold>)>']);
  assert.deepEqual(parts('[note](Folder/Dark%20rye.md)'), ['<a.rm-alias.rm-alias--page{Folder/Dark rye.md}:note>']);
  assert.deepEqual(parts('#wholesale and #[[two words]] and #a/b'), ['<span.rm-page-ref.rm-page-ref--tag{wholesale}:#wholesale>', ' and ', '<span.rm-page-ref.rm-page-ref--tag{two words}:#two words>', ' and ', '<span.rm-page-ref.rm-page-ref--tag{a/b}:#a/b>']);
  assert.deepEqual(parts('issue #12 and a#b'), ['issue #12 and a#b']);
});

test('a page title with links in it keeps them', () => {
  assert.deepEqual(parts('[[Bread by [[Tomás]]]]'), [`<span{Bread by [[Tomás]]}:(<span.rm-page-ref__brackets:[[>|<span.rm-page-ref.rm-page-ref--link{Bread by [[Tomás]]}:(Bread by |${ref('Tomás')})>|<span.rm-page-ref__brackets:]]>)>`]);
});

test('emphasis in both spellings', () => {
  assert.deepEqual(parts('**b** __i__ *i* ^^h^^ ==h== ~~s~~ `c`'), ['<span.rm-bold:b>', ' ', '<em.rm-italics:i>', ' ', '<em.rm-italics:i>', ' ', '<span.rm-highlight:h>', ' ', '<span.rm-highlight:h>', ' ', '<del.rm-strikethrough:s>', ' ', '<code:c>']);
  assert.deepEqual(parts('snake__case__name and 2 * 3 * 4'), ['snake__case__name and 2 * 3 * 4']);
  assert.deepEqual(parts('**with [[Link]]**'), [`<span.rm-bold:(with |${ref('Link')})>`]);
  assert.deepEqual(parts('`[[not a link]]`'), ['<code:[[not a link]]>']);
});

test('tasks and attributes at the start of a block', () => {
  const box = (cls: string) => `<span.rm-checkbox.${cls}.rv-checkbox:(<label.check-container:(<input:>|<span.checkmark:>)>)>`;
  assert.deepEqual(parts('{{[[TODO]]}} send the list'), [box('rm-todo'), ' send the list']);
  assert.deepEqual(parts('{{DONE}} sent'), [box('rm-done'), ' sent']);
  assert.deepEqual(parts('[ ] send'), [box('rm-todo'), ' ', 'send']);
  assert.deepEqual(parts('[x] sent'), [box('rm-done'), ' ', 'sent']);
  assert.deepEqual(parts('Oven:: 250° with [[Steam]]'), ['<span.rm-attr-ref{Oven}:Oven:>', ' 250° with ', ref('Steam')]);
  assert.deepEqual(parts('std::vector and a:: b in the middle::'), ['std::vector and a:: b in the middle::']);
});

test('web links open in the browser; what Roam would run or fetch stays text', () => {
  assert.deepEqual(parts('[site](https://example.com/a) and https://example.com/b.'), ['<a.rm-alias.rm-alias--external:site>', ' and ', '<a:https://example.com/b>', '.']);
  assert.deepEqual(parts('{{query: {and: [[A]]}}} ((abcdefghi)) {{iframe: https://example.com}}').filter((p) => p.startsWith('<')), [ref('A'), '<a:https://example.com>']);
  assert.deepEqual(parts('[[unclosed and [half](open'), ['[[unclosed and [half](open']);
});

test('what Obsidian hides or ticks is hidden or ticked: comments, block ids, any task status', () => {
  assert.deepEqual(body('before %%a private remark%% after'), [0, 'before ', ' after']);
  assert.deepEqual(body('open %%hides the rest'), [0, 'open ']);
  assert.deepEqual(body('Fed at 7 and 19 ^a1b2c3'), [0, 'Fed at 7 and 19']);
  assert.deepEqual(body('^a1b2c3'), [0]);
  assert.deepEqual(body('^^kept^^'), [0, 'span.rm-highlight:kept']);
  for (const s of ['x', '/', '-', '?', '!']) assert.equal(String(body(`[${s}] order flour`)[1]).startsWith('span.rm-checkbox rm-done'), true, s);
  assert.equal(String(body('[ ] order flour')[1]).startsWith('span.rm-checkbox rm-todo'), true);
  assert.deepEqual(body('[1] Smith 2020'), [0, '[1] Smith 2020']);
});

test('a link keeps the heading or block it names, for the click', () => {
  const root = new El('div');
  inline(root as unknown as HTMLElement, '[[Dark rye#Proof]] [[Dark rye#^fold|the fold]] [m](Dark%20rye.md#Proof) [[Dark rye]]');
  const subs: (string | undefined)[] = [];
  const walk = (k: El | string) => { if (typeof k === 'string') return; if (k.dataset.rvTarget !== undefined) subs.push(k.dataset.rvSub); k.kids.forEach(walk); };
  root.kids.forEach(walk);
  assert.deepEqual(subs, ['#Proof', '#^fold', '#Proof', undefined]);
});

test('embeds: a picture of the vault is Roam\'s image, a note, heading or block starts as its link', () => {
  const seen = (s: string) => { const root = new El('div'); inline(root as unknown as HTMLElement, s); return root.kids[0] as El; };
  const one = (k: El): El => (k.kids[0] as El).kids[0] as El;
  for (const [s, target, alt, width] of [['![[crumb.png]]', 'crumb.png', '', '500px'], ['![[pictures/crumb.PNG|300]]', 'pictures/crumb.PNG', '', '300px'], ['![open crumb](pictures/crumb%20one.png)', 'pictures/crumb one.png', 'open crumb', '500px'], ['![open crumb|120x80](crumb.jpg)', 'crumb.jpg', 'open crumb', '120px']] as const) {
    const box = seen(s), i = one(box) as any;
    assert.deepEqual([box.className, i.dataset.rvImg, i.alt, (box.style as any).width], ['rm-inline-img__resize hoverparent', target, alt, width], s);
  }
  // a picture on the web is not fetched: it stays a link, as before
  assert.equal(seen('![x](https://example.com/a.png)').className, 'rm-alias rm-alias--external');
  for (const [s, target, sub] of [['![[Proofing]]', 'Proofing', undefined], ['![[Proofing#Cold]]', 'Proofing', '#Cold'], ['![[Proofing#^cold]]', 'Proofing', '#^cold'], ['![[plan.pdf]]', 'plan.pdf', undefined]] as const) {
    const box = seen(s);
    assert.deepEqual([box.tag, box.dataset.rvEmbed, box.dataset.rvEmbedSub, box.textContent.startsWith('[[📎 ')], ['span', target, sub, true], s);
  }
});

test('a Markdown table is Roam\'s table', () => {
  const root = new El('div');
  assert.equal(blockBody(root as unknown as HTMLElement, '| Loaf | Hours |\n| :--- | ---: |\n| **Rye** | 18 |\n| [[a\\|b]] | x \\| y | extra |'), 0);
  const box = (root.kids[0] as El).kids[0] as El, tb = ((box.kids[0] as El).kids[0] as El);
  assert.equal(box.className, 'rm-table hoverparent dont-focus-block nodrag');
  assert.deepEqual(tb.kids.map((tr) => (tr as El).kids.map((td) => (td as El).textContent)), [['Loaf', 'Hours', ''], ['Rye', '18', ''], ['b', 'x | y', 'extra']]);
  assert.equal((((tb.kids[1] as El).kids[0] as El).kids[0] as El).className, 'rm-table__cell');
  // pipes without the line of dashes are text
  assert.deepEqual(body('| not | a table |\n| just | pipes |').length, 2);
});

test('footnotes are block references: [^1] to the footnote\'s block, ^[text] with its text', () => {
  const root = new El('div');
  blockBody(root as unknown as HTMLElement, 'Rye proves slower[^rye] and needs warmth^[about 26°].');
  const refs = root.kids.filter((k): k is El => typeof k !== 'string' && k.className.includes('rm-block-ref'));
  assert.equal(refs.length, 2);
  assert.deepEqual([refs[0].dataset.rvTarget, refs[0].dataset.rvSub, refs[0].textContent], ['', '#[^rye]', '[^rye]']);
  assert.equal(refs[1].textContent, 'about 26°');
  assert.equal(root.textContent, 'Rye proves slower[^rye] and needs warmthabout 26°.');
});
