// A deliberately small, read-only Markdown renderer for the note viewer. Covers what
// most vault notes use: frontmatter, headings, lists, quotes, code, emphasis, wikilinks,
// embeds, Markdown links and tags. Everything else shows as plain text. Builds DOM
// nodes directly, so note text is never parsed as HTML.
import { splitFrontmatter } from '../core/frontmatter.ts';

export function renderMarkdown(text: string, highlightLine?: number): DocumentFragment {
  const frag = document.createDocumentFragment();
  const fm = splitFrontmatter(text);
  const lines = text.split(/\r?\n/); // notes saved on Windows end lines with \r\n
  let i = 0;
  if (fm.raw !== null) {
    const end = fm.bodyStartLine;
    const props = document.createElement('div');
    props.className = 'rv-props';
    props.textContent = lines.slice(1, end - 1).join('\n');
    props.style.whiteSpace = 'pre-wrap';
    if (highlightLine !== undefined && highlightLine < end) props.classList.add('rv-hl');
    frag.append(props);
    i = end;
  }
  for (; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const start = i;
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) code.push(lines[i]);
      const pre = document.createElement('pre');
      pre.textContent = code.join('\n');
      if (highlightLine !== undefined && highlightLine >= start && highlightLine <= i) pre.classList.add('rv-hl');
      frag.append(pre);
      continue;
    }
    let el: HTMLElement;
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      el = document.createElement(`h${Math.min(m[1].length + 1, 6)}`);
      inline(el, m[2]);
    } else if ((m = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line))) {
      el = document.createElement('div');
      el.className = 'rv-li';
      el.style.setProperty('--d', String(Math.floor(m[1].replace(/\t/g, '    ').length / 2)));
      if (m[2]) el.append(m[2] === ' ' ? '☐ ' : '☑ ');
      inline(el, m[3]);
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      el = document.createElement('blockquote');
      inline(el, m[1].replace(/^\[!(\w+)\][+-]?\s*/, (_, k) => `${k}: `));
    } else if (!line.trim()) {
      continue;
    } else {
      el = document.createElement('p');
      inline(el, line);
    }
    if (i === highlightLine) el.classList.add('rv-hl');
    frag.append(el);
  }
  return frag;
}

const INLINE = /(!?)\[\[([^\]\n]+?)\]\]|!?\[([^\]\n]*)\]\(([^)\n]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w&/])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

/** Render one line of Markdown inline syntax into parent (used for panel snippets too). */
export function inline(parent: HTMLElement, s: string) {
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    if (m.index! > last) parent.append(s.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[2] !== undefined) {
      const [targetPart, alias] = splitPipe(m[2]);
      const target = targetPart.replace(/#.*$/, '').trim();
      const a = document.createElement('span');
      a.className = 'rv-wl';
      a.dataset.target = target || '';
      a.textContent = (m[1] ? '📎 ' : '') + (alias ?? targetPart);
      // Like Roam: [[Page]] keeps faint brackets; an aliased link shows only its text.
      if (alias === null) parent.append(bracket('[['), a, bracket(']]')); else parent.append(a);
    } else if (m[4] !== undefined) {
      const href = m[4].trim().replace(/^<|>$/g, '');
      if (/^https?:\/\//i.test(href)) {
        const a = document.createElement('a');
        a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = m[3] || href;
        parent.append(a);
      } else {
        const a = document.createElement('span');
        a.className = 'rv-wl';
        let t = href; try { t = decodeURIComponent(href); } catch { /* keep raw */ }
        a.dataset.target = t.replace(/#.*$/, '');
        a.textContent = m[3] || t;
        parent.append(a);
      }
    } else if (m[5] !== undefined) {
      const c = document.createElement('code'); c.textContent = m[5]; parent.append(c);
    } else if (m[6] !== undefined) {
      const b = document.createElement('strong'); b.textContent = m[6]; parent.append(b);
    } else if (m[7] !== undefined) {
      const e = document.createElement('em'); e.textContent = m[7]; parent.append(e);
    } else if (m[8] !== undefined) {
      const t = document.createElement('span'); t.className = 'rv-tag'; t.textContent = '#' + m[8]; parent.append(t);
    }
  }
  if (last < s.length) parent.append(s.slice(last));
}

function bracket(t: string) {
  const b = document.createElement('span');
  b.className = 'rv-br';
  b.textContent = t;
  return b;
}

function splitPipe(inner: string): [string, string | null] {
  const i = inner.search(/\\?\|/);
  if (i < 0) return [inner, null];
  const sep = inner[i] === '\\' ? 2 : 1;
  return [inner.slice(0, i), inner.slice(i + sep) || null];
}
