// Draws the text of a block of a note. Read-only, and deliberately small: it covers what most vault
// notes use (emphasis, wikilinks, embeds, Markdown links, tags, tasks, quotes, code) and shows
// everything else as plain text. It builds DOM nodes directly, so note text is never parsed as HTML,
// and nothing in a note is run or fetched (no queries, embeds, iframes or images), which Roam's own
// renderer would do with text it is given.
//
// Inline text is drawn with the elements and class names Roam itself draws a block's text with
// (measured in Roam's Linked References, 2026-11-22), so it looks the same and a theme that
// restyles Roam restyles it too. Both Obsidian's and Roam's spelling of each thing is read, since
// a vault can be an export of a Roam graph: [[Page|alias]] and [alias]([[Page]]), *i* and __i__,
// ==h== and ^^h^^, "- [ ] " and {{[[TODO]]}}, #a/b and #[[a b]], Name:: attributes.

/** Draw a block's text into `parent`. Most blocks are a line of inline text; a block can also hold
 *  fenced code, be a quote (each line "> "), or be a heading ("## text"). Returns the heading's level,
 *  0 for a block that is none. */
export function blockBody(parent: HTMLElement, text: string): number {
  const heading = /^(#{1,6})[ \t]+/.exec(text);
  if (heading) { inline(parent, text.slice(heading[0].length)); return heading[1].length; }
  if (/^>[ \t]?/.test(text) && text.split('\n').every((l) => l.startsWith('>'))) {
    const q = el('blockquote', 'rm-bq');
    const lines = text.split('\n').map((l) => l.replace(/^>[ \t]?/, ''));
    // an Obsidian callout: "> [!note] Title" names its kind and title on the first line
    lines[0] = lines[0].replace(/^\[!(\w+)\][+-]?[ \t]*/, (_, kind) => (lines[0].replace(/^\[!\w+\][+-]?[ \t]*/, '') ? '' : kind[0].toUpperCase() + kind.slice(1)));
    inline(q, lines.join('\n'));
    parent.append(q);
    return 0;
  }
  if (/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(text)) { parent.append(el('hr', 'rm-hr')); return 0; }
  if (text[0] === '|' && tableOf(parent, text)) return 0;
  if (!/(^|\n)[ \t]*(```|~~~)/.test(text)) { inline(parent, text); return 0; }
  // text with fenced code in it: the text as text, the code as code
  const lines = text.split('\n');
  let plain: string[] = [];
  const flush = () => { if (plain.length) { const sp = el('span'); inline(sp, plain.join('\n')); parent.append(sp); plain = []; } };
  for (let i = 0; i < lines.length; i++) {
    const fence = /^([ \t]*)(```|~~~)/.exec(lines[i]);
    if (!fence) { plain.push(lines[i]); continue; }
    flush();
    const code: string[] = [];
    for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[2]); i++) code.push(lines[i]);
    const pre = el('pre', 'rv-code');
    pre.append(el('code', '', code.join('\n')));
    parent.append(pre);
  }
  flush();
  return 0;
}

/** The cells of a row of a Markdown table. A pipe after a backslash is in a cell, not between two. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, (m, at: number, all: string) => (all[at - 1] === '\\' ? m : ''));
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cell += '|'; i++; }
    else if (s[i] === '|') { out.push(cell.trim()); cell = ''; }
    else cell += s[i];
  }
  out.push(cell.trim());
  return out;
}
/** A Markdown table as Roam's {{table}} (measured in Roam, 2026-11-23): rows of cells 150 wide, the
 *  first row like the others. False when the text is no table. */
function tableOf(parent: HTMLElement, text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 2 || !/^\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(lines[1]) || !lines[1].includes('-')) return false;
  const rows = [lines[0], ...lines.slice(2)].filter((l) => l.trim()).map(cells);
  const width = Math.max(...rows.map((r) => r.length));
  const body = el('tbody');
  rows.forEach((row, y) => {
    const tr = el('tr');
    for (let x = 0; x < width; x++) {
      const td = el('td'), cell = el('div', 'rm-table__cell'), sp = el('span');
      td.dataset.row = String(y); td.dataset.col = String(x);
      td.style.minWidth = td.style.maxWidth = '150px';
      inline(sp, row[x] ?? '');
      cell.append(sp); td.append(cell); tr.append(td);
    }
    body.append(tr);
  });
  const table = el('table'), box = el('div', 'rm-table hoverparent dont-focus-block nodrag'), wrap = el('span', 'dont-focus-block');
  table.append(body); box.append(table); wrap.append(box); parent.append(wrap);
  return true;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Where an inline thing can start. What starts there is tried in order; what fits nothing is text. */
const START = /!?\[|\^\[|`|%%|\*\*|__|\^\^|==|~~|\*|#|\{\{|https?:\/\//g;
const RE_TAG = /^#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/u;
const RE_URL = /^https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]}'"]/;
const RE_TODO = /^\{\{(?:\[\[)?(TODO|DONE)(?:\]\])?\}\}/;
const RE_ATTR = /^([^:`[\]{}()#\n][^:`{}\n]{0,80}?)::(?=\s|$)/;
// Obsidian draws a box for any status and ticks every one but the empty one: [x], [/], [-], [?], [!], ...
const RE_TASK = /^\[([ xX/\-?!><*])\]\s+/;
// a block's id, which Obsidian hides: "text ^a1b2c3", or a line that is only the id
const RE_BLOCK_ID = /(?:^|[ \t])\^[A-Za-z0-9-]+[ \t]*$/;

/** Render one line of inline syntax into parent (used for panel lines and breadcrumbs too). */
export function inline(parent: HTMLElement, s: string) {
  let at = 0;
  s = s.replace(RE_BLOCK_ID, '');
  // what only the start of a block can be: a task box, an attribute's name
  let m = RE_TASK.exec(s);
  if (m) { parent.append(checkbox(m[1] !== ' '), ' '); at = m[0].length; }
  else if ((m = RE_ATTR.exec(s))) {
    const a = el('span', 'rm-attr-ref', m[1] + ':');
    a.dataset.rvTarget = m[1].trim();
    parent.append(a); at = m[0].length;
  }
  spans(parent, s, at);
}

function spans(parent: HTMLElement, s: string, from = 0) {
  let last = from;
  const text = (to: number) => { if (to > last) parent.append(s.slice(last, to)); };
  START.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = START.exec(s))) {
    const i = m.index;
    const end = thing(parent, s, i, m[0], () => text(i));
    if (end > i) { last = end; START.lastIndex = end; } else START.lastIndex = i + 1;
  }
  text(s.length);
}

/** Draw what starts at s[i], if anything does; returns where it ends (i when nothing fits). `flush`
 *  puts the plain text before it in first. */
function thing(parent: HTMLElement, s: string, i: number, tok: string, flush: () => void): number {
  const put = (end: number, ...nodes: (Node | string)[]) => { flush(); parent.append(...nodes); return end; };
  if (tok === '%%') {
    // an Obsidian comment, hidden as in its reading view; one left open hides the rest
    const c = s.indexOf('%%', i + 2);
    return put(c < 0 ? s.length : c + 2);
  }
  if (tok === '^[') {
    // an inline footnote, ^[text]: Roam has no footnotes, so it is a block reference with its text
    const c = closing(s, i + 2, '[', ']');
    if (c < 0 || c === i + 2) return i;
    const ref = el('span', 'rm-block-ref dont-focus-block');
    spans(ref, s.slice(i + 2, c));
    return put(c + 1, ref);
  }
  const embed = tok[0] === '!';
  const o = embed ? i + 1 : i;
  if (tok === '[' && s[o + 1] === '^') {
    // a footnote, [^1]: a block reference to the footnote's own block, which shows its text
    const m = /^\[\^([^\]\s]+)\](?!:)/.exec(s.slice(o, o + 120));
    if (m) return put(o + m[0].length, blockRef('', `#[^${m[1]}]`, m[0]));
  }
  if (tok.endsWith('[')) {
    if (s[o + 1] === '[') {
      // [[Page]], [[Page|alias]], [[a [[nested]] title]]
      const close = balanced(s, o);
      if (close < 0) return i;
      const inner = s.slice(o + 2, close);
      if (!inner.trim()) return i;
      const [targetPart, alias] = splitPipe(inner);
      const hash = targetPart.indexOf('#');
      const target = (hash < 0 ? targetPart : targetPart.slice(0, hash)).trim();
      const sub = hash < 0 ? '' : targetPart.slice(hash).trim();
      if (embed && IMAGE.test(target)) return put(close + 2, image(target, alias ?? ''));
      // a link to a heading reads "Note > Heading", as Obsidian shows it
      const shown = sub ? [target, ...sub.split('#').filter(Boolean)].filter(Boolean).join(' > ') : targetPart;
      const link = alias !== null ? pageAlias(target, (embed ? '📎 ' : '') + alias, sub)
        : sub.startsWith('#^') && !embed ? blockRef(target, sub, targetPart)
        : pageRef(target, (embed ? '📎 ' : '') + shown, sub);
      return put(close + 2, embed ? embedOf(target, sub, link) : link);
    }
    // [text](dest), ![alt](dest)
    const mid = closing(s, o + 1, '[', ']');
    if (mid < 0 || s[mid + 1] !== '(') return i;
    const label = s.slice(o + 1, mid);
    let dest: string, end: number;
    if (s.startsWith('[[', mid + 2)) {
      const c = balanced(s, mid + 2);
      if (c < 0 || s[c + 2] !== ')') return i;
      return put(c + 3, pageAlias(s.slice(mid + 4, c).trim(), label));
    }
    if (s.startsWith('((', mid + 2)) {
      const c = s.indexOf(')))', mid + 4);
      if (c < 0) return i;
      return put(c + 3, el('a', 'rm-alias rm-alias--block', label));
    }
    end = closing(s, mid + 2, '(', ')');
    if (end < 0) return i;
    dest = s.slice(mid + 2, end).trim().replace(/\s+(?:"[^"]*"|'[^']*')$/, '').replace(/^<|>$/g, '');
    if (!dest || /\n/.test(dest)) return i;
    if (/^https?:\/\//i.test(dest)) {
      const a = el('a', 'rm-alias rm-alias--external', label || dest);
      a.href = dest; a.target = '_blank'; a.rel = 'noopener noreferrer';
      return put(end + 1, a);
    }
    let t = dest; try { t = decodeURIComponent(dest); } catch { /* keep raw */ }
    if (embed && IMAGE.test(t)) return put(end + 1, image(t, label));
    const at = t.indexOf('#');
    return put(end + 1, pageAlias(at < 0 ? t : t.slice(0, at), label || t, at < 0 ? '' : t.slice(at)));
  }
  if (tok === '`') {
    const c = s.indexOf('`', i + 1);
    if (c < 0 || c === i + 1 || s.slice(i + 1, c).includes('\n')) return i;
    return put(c + 1, el('code', '', s.slice(i + 1, c)));
  }
  if (tok === '**' || tok === '__' || tok === '^^' || tok === '==' || tok === '~~') {
    const c = s.indexOf(tok, i + 2);
    if (c < 0 || c === i + 2 || s.slice(i + 2, c).includes('\n')) return i;
    if (tok === '__' && (/\w/.test(s[i - 1] ?? '') || /\w/.test(s[c + 2] ?? ''))) return i; // snake__case
    const e = tok === '**' ? el('span', 'rm-bold') : tok === '__' ? el('em', 'rm-italics') : tok === '~~' ? el('del', 'rm-strikethrough') : el('span', 'rm-highlight');
    spans(e, s.slice(i + 2, c));
    return put(c + 2, e);
  }
  if (tok === '*') {
    if (/[\w*]/.test(s[i - 1] ?? '')) return i;
    const c = s.indexOf('*', i + 1);
    if (c < 0 || c === i + 1 || /[\w*]/.test(s[c + 1] ?? '') || /\s/.test(s[i + 1]) || s.slice(i + 1, c).includes('\n')) return i;
    const e = el('em', 'rm-italics');
    spans(e, s.slice(i + 1, c));
    return put(c + 1, e);
  }
  if (tok === '#') {
    if (/[\w&/]/.test(s[i - 1] ?? '')) return i;
    if (s.startsWith('[[', i + 1)) {
      const c = balanced(s, i + 1);
      if (c < 0) return i;
      return put(c + 2, tag(s.slice(i + 3, c)));
    }
    const m = RE_TAG.exec(s.slice(i, i + 200));
    return m ? put(i + m[0].length, tag(m[1])) : i;
  }
  if (tok === '{{') {
    const m = RE_TODO.exec(s.slice(i, i + 16));
    return m ? put(i + m[0].length, checkbox(m[1] === 'DONE')) : i;
  }
  if (tok.startsWith('http')) {
    if (/[\w/]/.test(s[i - 1] ?? '')) return i;
    const m = RE_URL.exec(s.slice(i));
    if (!m) return i;
    const a = el('a', '', m[0]);
    a.href = m[0]; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return put(i + m[0].length, a);
  }
  return i;
}

/** The index of the ]] that closes the [[ at s[i], counting [[ ]] inside it; -1 when there is none on the line. */
function balanced(s: string, i: number): number {
  let depth = 0;
  for (let k = i; k < s.length - 1; k++) {
    const c = s[k];
    if (c === '\n') return -1;
    if (c === '[' && s[k + 1] === '[') { depth++; k++; }
    else if (c === ']' && s[k + 1] === ']') { if (--depth === 0) return k; k++; }
  }
  return -1;
}
/** The index of the `close` that ends what `open` began just before s[i]; -1 when there is none on the line. */
function closing(s: string, i: number, open: string, close: string): number {
  let depth = 1;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '\n') return -1;
    if (c === open) depth++;
    else if (c === close && --depth === 0) return k;
  }
  return -1;
}

/** [[Page]] as Roam draws it. The brackets are there or not as Roam's own are (see brackets.ts). */
function pageRef(target: string, shown: string, sub = ''): HTMLElement {
  const wrap = el('span');
  wrap.dataset.linkTitle = target;
  const a = el('span', 'rm-page-ref rm-page-ref--link');
  a.dataset.rvTarget = target;
  if (sub) a.dataset.rvSub = sub; // the heading the link names
  if (shown.includes('[[')) spans(a, shown); else a.textContent = shown; // a title with links in it
  wrap.append(el('span', 'rm-page-ref__brackets', '[['), a, el('span', 'rm-page-ref__brackets', ']]'));
  return wrap;
}
const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i;
/** An image of the vault, ![[loaf.png]], ![[loaf.png|300]], ![alt](loaf.png): Roam's inline image.
 *  Whoever draws the block reads the file and puts it in (`data-rv-img`). Roam's box is 500 wide
 *  until the image is resized; a width written Obsidian's way is that size. */
function image(target: string, label: string): HTMLElement {
  const size = /(?:^|\|)\s*(\d+)(?:x\d+)?\s*$/.exec(label);
  const width = `${size ? Math.max(20, +size[1]) : 500}px`;
  const box = el('div', 'rm-inline-img__resize hoverparent'), inner = el('div', 'react-resizable'), img = el('img', 'rm-inline-img');
  box.style.width = inner.style.width = width;
  if (size) img.style.width = '100%';
  img.alt = size ? label.slice(0, size.index) : label;
  img.draggable = false;
  img.dataset.rvImg = target;
  inner.append(img); box.append(inner);
  return box;
}
/** An embedded note, heading or block, ![[Note]], ![[Note#Heading]], ![[Note#^id]]. It starts as the
 *  link it was; whoever draws the block draws what it names in its place (`data-rv-embed`). */
function embedOf(target: string, sub: string, link: HTMLElement): HTMLElement {
  const box = el('span');
  box.dataset.rvEmbed = target;
  if (sub) box.dataset.rvEmbedSub = sub;
  box.append(link);
  return box;
}
/** A link to a block of a note, [[Note#^id]]: Roam's block reference, which shows the block's text.
 *  The text is put in by whoever draws the block (`data-rv-fill`); until then it is the link as written. */
function blockRef(target: string, sub: string, written: string): HTMLElement {
  const ref = el('span', 'rm-block-ref dont-focus-block');
  ref.dataset.rvTarget = target; ref.dataset.rvSub = sub; ref.dataset.rvFill = '';
  ref.append(el('span', '', written));
  return ref;
}
/** A link with text of its own: Obsidian's [[Page|text]], Roam's [text]([[Page]]). */
function pageAlias(target: string, shown: string, sub = ''): HTMLElement {
  const a = el('a', 'rm-alias rm-alias--page');
  a.dataset.rvTarget = target;
  if (sub) a.dataset.rvSub = sub;
  spans(a, shown);
  return a;
}
function tag(name: string): HTMLElement {
  const t = el('span', 'rm-page-ref rm-page-ref--tag', '#' + name);
  t.dataset.tag = name;
  t.dataset.rvTarget = name;
  return t;
}
/** Roam's TODO box. Not for ticking: the note is only read. */
function checkbox(done: boolean): HTMLElement {
  const box = el('span', `rm-checkbox ${done ? 'rm-done' : 'rm-todo'} rv-checkbox`);
  const label = el('label', 'check-container');
  const input = el('input');
  input.type = 'checkbox'; input.checked = done; input.disabled = true;
  label.append(input, el('span', 'checkmark'));
  box.append(label);
  return box;
}

function splitPipe(inner: string): [string, string | null] {
  if (inner.includes('[[')) return [inner, null]; // a title with links in it has no alias
  const i = inner.search(/\\?\|/);
  if (i < 0) return [inner, null];
  const sep = inner[i] === '\\' ? 2 : 1;
  return [inner.slice(0, i), inner.slice(i + sep) || null];
}
