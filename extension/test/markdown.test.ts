import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/main/markdown.ts';

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

const shape = (text: string, line?: number) =>
  (renderMarkdown(text, line) as unknown as El).kids.map((k) => { const e = k as El; return `${e.tag}${e.className ? '.' + e.className : ''}:${e.textContent}`; });

const note = ['---', 'aliases: [Alpha]', '---', '# Title', '- item one', '- [x] done', '> quoted', 'plain [[Link]] text', '```', 'code', '```'];
const want = ['div.rv-props:aliases: [Alpha]', 'h2:Title', 'div.rv-li:item one', 'div.rv-li:\u2611 done', 'blockquote:quoted', 'p:plain [[Link]] text', 'pre:code'];

test('headings, lists, quotes and code render from a note with Unix line endings', () => {
  assert.deepEqual(shape(note.join('\n')), want);
});

test('a note saved with Windows line endings renders the same', () => {
  assert.deepEqual(shape(note.join('\r\n')), want);
});

test('the linked line is highlighted in a Windows note too', () => {
  const out = shape(note.join('\r\n'), 4);
  assert.equal(out[2], 'div.rv-li rv-hl:item one');
});
