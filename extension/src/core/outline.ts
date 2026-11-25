// The outline around a line of a note: the block the line is in, the blocks above it (its parents,
// outermost first) and the blocks under it. This is what Roam shows for a linked reference: the path
// of parent blocks, the block, its children. In Markdown a block is a list item ("- text", with the
// lines that continue it), nested by indentation, as Roam, Logseq and Obsidian's outliners write it;
// a heading is a parent of what follows it, up to the next heading of its level. No Node APIs.
import { isoToRoamDaily } from './dates.ts';
import { refDef, refDefs, inlineRefs } from './reflinks.ts';

export interface OutlineBlock {
  /** The block's text without its list marker; the lines of a block of several lines, joined by \n. */
  text: string;
  /** 0-based line of the file the block starts on. */
  line: number;
  /** Blocks nested under it. */
  kids: OutlineBlock[];
  /** Its number, for an item of a numbered list: drawn in place of the bullet, as Roam draws the
   *  children of a block viewed as numbered. */
  n?: number;
  /** It has blocks under it that were left out (see MAX_KIDS). */
  cut?: true;
}
export interface LineContext extends OutlineBlock {
  /** Parent blocks, outermost first: headings, then the list items the block is nested in. */
  up: { text: string; line: number }[];
}

/** Blocks under one line that come with it. A block that has more is marked `cut`. */
export const MAX_KIDS = 200;
/** Characters of one block that are kept. */
export const MAX_BLOCK = 2000;

const RE_ITEM = /^([ \t]*)(?:[-*+]|(\d+)[.)])(?:[ \t]+(.*))?$/;
const RE_RULE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RE_FOOTNOTE = /^\[\^[^\]\s]+\]:[ \t]*(.*)$/;
const RE_FENCE = /^[ \t]*(?:[-*+][ \t]+)?(`{3,}|~{3,})/;

interface Row {
  /** Width of the leading white space, a tab reaching the next multiple of 4. -1 for a blank line. */
  indent: number;
  kind: 'item' | 'heading' | 'text' | 'blank' | 'code';
  text: string;
  level: number; // of a heading
  /** The number an item of a numbered list is written with. */
  num?: number;
}

function width(ws: string): number {
  let w = 0;
  for (let i = 0; i < ws.length; i++) w = ws.charCodeAt(i) === 9 ? (w - (w % 4)) + 4 : w + 1;
  return w;
}

function rows(text: string): Row[] {
  const out: Row[] = [];
  let fence: string | null = null;
  let i = 0;
  // frontmatter is not outline
  const lines = text.split('\n');
  if (lines[0]?.replace(/\r$/, '') === '---') {
    const end = lines.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) for (; i <= end; i++) out.push({ indent: -1, kind: 'blank', text: '', level: 0 });
  }
  for (; i < lines.length; i++) {
    const raw = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    const ws = /^[ \t]*/.exec(raw)![0];
    const indent = width(ws);
    const f = RE_FENCE.exec(raw);
    if (fence !== null) {
      // inside a code block: never a block of its own
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && raw.trim() === f[1]) fence = null;
      out.push({ indent, kind: 'code', text: raw.slice(ws.length), level: 0 });
      continue;
    }
    let m: RegExpExecArray | null;
    if (!raw.trim()) { out.push({ indent: -1, kind: 'blank', text: '', level: 0 }); continue; }
    const item = RE_RULE.test(raw) ? null : RE_ITEM.exec(raw);
    if (f) {
      // a fence that opens and closes on its own line (```x```) is not a block of code
      const rest = raw.slice(raw.indexOf(f[1]) + f[1].length);
      if (!rest.includes(f[1])) fence = f[1];
    }
    if (item) out.push({ indent, kind: 'item', text: item[3] ?? '', level: 0, ...(item[2] ? { num: +item[2] } : {}) });
    else if ((m = RE_HEADING.exec(raw))) out.push({ indent: 0, kind: 'heading', text: m[2], level: m[1].length });
    else out.push({ indent, kind: f ? 'code' : 'text', text: raw.slice(ws.length), level: 0 });
  }
  // Footnotes: Roam has none, so each "[^1]: text" is a block of its text, and a use of it is a block
  // reference to that block (drawn by the renderer).
  for (let k = 0; k < out.length; k++) {
    const row = out[k];
    if (row.kind === 'text' && row.indent <= 3 && row.text.startsWith('[^')) {
      const m = RE_FOOTNOTE.exec(row.text);
      if (m) out[k] = { indent: 0, kind: 'item', text: m[1], level: 0 }; // each its own block, as in Obsidian's list of footnotes
    }
  }
  // Reference-style links: each use reads as the inline link it stands for, and the lines that
  // define them are hidden, as Obsidian's reading view hides them.
  if (text.includes(']:')) {
    const defs = refDefs(lines, (k) => out[k]?.kind !== 'text' || out[k].indent > 3);
    if (defs.size) {
      for (let k = 0; k < out.length; k++) {
        const row = out[k];
        if (row.kind === 'text' && row.indent <= 3 && refDef(lines[k])) out[k] = { indent: -1, kind: 'blank', text: '', level: 0 };
        else if (row.kind !== 'code' && row.kind !== 'blank') row.text = inlineRefs(row.text, defs);
      }
    }
  }
  return out;
}

const clip = (s: string) => (s.length > MAX_BLOCK ? s.slice(0, MAX_BLOCK - 1) + '…' : s);

/** The outline around some lines of a note. A line that is on no block of its own (a paragraph, a
 *  line of a block's code) gives the block it belongs to, or itself. */
/** `okf`: the note is in an OKF bundle (see propOne). */
export function contextOf(text: string, lines: number[], okf = false): LineContext[] {
  const r = rows(text);
  let props: ReturnType<typeof propsOf> | undefined;
  return lines.map((n) => {
    // a line of the frontmatter: its property, as the attribute block Roam would have for it
    if (n > 0 && r[n]?.indent === -1 && r[0]?.indent === -1 && (props ??= propsOf(text.split('\n'), okf)).end > n) {
      for (const p of props.blocks) {
        if (p.line === n) return { ...p, up: [] };
        const kid = p.kids.find((k) => k.line === n);
        if (kid) return { ...kid, up: [{ text: p.text, line: p.line }] };
      }
    }
    return context(r, Math.max(0, Math.min(n, r.length - 1)));
  });
}

/** The first line of the block a line is in. */
function ownerOf(r: Row[], n: number): number {
  const row = r[n];
  if (!row || row.kind === 'item' || row.kind === 'heading') return n;
  // a continuation: lines further in than a list item above, with nothing less indented between
  let least = row.indent < 0 ? Infinity : row.indent;
  for (let i = n - 1; i >= 0; i--) {
    const p = r[i];
    if (p.kind === 'blank') continue;
    if (p.kind === 'heading') break;
    if (p.kind === 'item') { if (p.indent < least) return i; continue; }
    if (p.indent === 0 && p.kind === 'text') break; // a paragraph at the margin: no list above
    least = Math.min(least, p.indent);
  }
  // a line of a paragraph: the paragraph starts where its run of text lines does
  let start = n;
  if (row.kind === 'text') while (start > 0 && r[start - 1].kind === 'text') start--;
  return start;
}

/** One past the last line of the paragraph that starts on line n. */
function paraEnd(r: Row[], n: number): number {
  let end = n + 1;
  while (end < r.length && r[end].kind === 'text') end++;
  return end;
}

/** A paragraph's lines as one block. Lines wrapped in the file are one line of text, as Markdown
 *  reads them; a line that ends in two spaces or a backslash, a table and a quote keep their lines. */
function paraText(part: Row[]): string {
  if (part.length === 1) return part[0].text;
  if (part.some((p) => /^[|>]/.test(p.text))) {
    const base = Math.min(...part.map((p) => p.indent));
    return part.map((p) => ' '.repeat(p.indent - base) + p.text).join('\n');
  }
  let out = '';
  part.forEach((p, k) => {
    const hard = /( {2,}|\\)$/.test(p.text);
    out += p.text.replace(/( {2,}|\\)$/, '').trimEnd() + (k === part.length - 1 ? '' : hard ? '\n' : ' ');
  });
  return out;
}

/** The lines after a list item's first that are still its own text: one past the last. */
function ownEnd(r: Row[], n: number): number {
  const at = r[n].indent;
  let end = n + 1, i = n + 1;
  for (; i < r.length; i++) {
    const p = r[i];
    if (p.kind === 'blank') continue;
    if (p.kind === 'item' || p.kind === 'heading' || p.indent <= at) break;
    end = i + 1;
  }
  return end;
}

function blockText(r: Row[], n: number): string {
  const row = r[n];
  if (row.kind === 'text') return clip(paraText(r.slice(n, paraEnd(r, n))));
  if (row.kind !== 'item') return clip(row.text);
  const end = ownEnd(r, n);
  if (end === n + 1) return clip(row.text);
  // lines that continue the item, less the indentation they share
  const more = r.slice(n + 1, end);
  const base = Math.min(...more.filter((p) => p.kind !== 'blank').map((p) => p.indent));
  return clip([row.text, ...more.map((p) => (p.kind === 'blank' ? '' : ' '.repeat(Math.max(0, p.indent - base)) + p.text))].join('\n').trimEnd());
}

function context(r: Row[], n: number): LineContext {
  if (!r.length) return { text: '', line: 0, kids: [], up: [] };
  let at = ownerOf(r, n);
  // a paragraph too long to show whole: the line itself, so that what was asked for is in the text
  let alone = false;
  if (at !== n && r[at].kind === 'text') {
    let chars = 0;
    for (let i = at, end = paraEnd(r, at); i < end && chars <= MAX_BLOCK; i++) chars += r[i].text.length + 1;
    if (chars > MAX_BLOCK) { at = n; alone = true; }
  }
  const row = r[at];
  const up: { text: string; line: number }[] = [];
  if (row.kind === 'item') {
    let least = row.indent;
    for (let i = at - 1; i >= 0 && least > 0; i--) {
      const p = r[i];
      if (p.kind === 'blank' || p.kind === 'code') continue;
      if (p.kind === 'heading') break;
      if (p.kind === 'item') { if (p.indent < least) { up.unshift({ text: firstLine(p.text), line: i }); least = p.indent; } continue; }
      if (p.indent === 0) break; // a paragraph at the margin ends the list above it
    }
  }
  // headings above: each one of a lower level than the last found
  let level = row.kind === 'heading' ? row.level : 7;
  const heads: { text: string; line: number }[] = [];
  for (let i = (up[0]?.line ?? at) - 1; i >= 0 && level > 1; i--) {
    const p = r[i];
    if (p.kind === 'heading' && p.level < level) { heads.unshift({ text: p.text, line: i }); level = p.level; }
  }
  const budget = { n: MAX_KIDS };
  const b: LineContext = { text: alone ? clip(row.text) : blockText(r, at), line: at, kids: [], up: [...heads, ...up] };
  if (row.kind === 'item') kidsOf(r, at, b, budget);
  else if (row.kind === 'heading') fill(r, at + 1, sectionEnd(r, at), b, budget); // what the heading owns
  return b;
}

const firstLine = (s: string) => clip(s);

/** The number of a numbered item that comes after `before` under the same block: one more than the
 *  item before it, or the number it is written with when it starts the list, as Markdown counts. */
function numOf(row: Row, before: OutlineBlock[]): { n?: number } {
  if (row.num === undefined) return {};
  const last = before[before.length - 1];
  return { n: last?.n !== undefined ? last.n + 1 : row.num };
}

/** Fill a list item's nested items in; returns the line after the last one. */
function kidsOf(r: Row[], n: number, into: OutlineBlock, budget: { n: number }): number {
  const at = r[n].indent;
  let i = ownEnd(r, n);
  while (i < r.length) {
    const p = r[i];
    if (p.kind === 'blank') { i++; continue; }
    if (p.kind !== 'item' || p.indent <= at) break;
    if (budget.n <= 0) { into.cut = true; return skip(r, i, at); }
    budget.n--;
    const kid: OutlineBlock = { text: blockText(r, i), line: i, kids: [], ...numOf(r[i], into.kids) };
    into.kids.push(kid);
    i = kidsOf(r, i, kid, budget);
  }
  return i;
}

/** The first line at or after `i` that is no longer under an item indented `at`. */
function skip(r: Row[], i: number, at: number): number {
  for (; i < r.length; i++) {
    const p = r[i];
    if (p.kind === 'blank' || p.kind === 'code') continue;
    if (p.kind === 'heading' || p.indent <= at) break;
  }
  return i;
}

/** Every block under one block of a note, for a block that came `cut`. */
export function kidsAt(text: string, line: number): OutlineBlock[] {
  const r = rows(text);
  if (r[line]?.kind !== 'item' && r[line]?.kind !== 'heading') return [];
  const b: OutlineBlock = { text: '', line, kids: [] };
  if (r[line].kind === 'heading') fill(r, line + 1, sectionEnd(r, line), b, { n: Infinity });
  else kidsOf(r, line, b, { n: Infinity });
  return b.kids;
}

/** The blocks of lines [i, end) of a note, put under `root`: headings with what follows them, list
 *  items nested by indentation, paragraphs and code. Stops adding when the budget is spent, and
 *  marks `root` cut. */
function fill(r: Row[], i: number, end: number, root: OutlineBlock, budget: { n: number }) {
  const heads: { level: number; b: OutlineBlock }[] = [];
  let items: { indent: number; b: OutlineBlock }[] = [];
  const under = () => heads[heads.length - 1]?.b ?? root;
  const spend = () => { if (budget.n <= 0) { root.cut = true; return false; } budget.n--; return true; };
  while (i < end) {
    const row = r[i];
    if (row.kind === 'blank') { i++; continue; }
    if (!spend()) return;
    if (row.kind === 'heading') {
      while (heads.length && heads[heads.length - 1].level >= row.level) heads.pop();
      const b: OutlineBlock = { text: clip('#'.repeat(row.level) + ' ' + row.text), line: i, kids: [] };
      under().kids.push(b); heads.push({ level: row.level, b }); items = [];
      i++; continue;
    }
    if (row.kind === 'item') {
      while (items.length && items[items.length - 1].indent >= row.indent) items.pop();
      const to = items[items.length - 1]?.b ?? under();
      const b: OutlineBlock = { text: blockText(r, i), line: i, kids: [], ...numOf(row, to.kids) };
      to.kids.push(b); items.push({ indent: row.indent, b });
      i = ownEnd(r, i); continue;
    }
    // a paragraph, a quote, a table: the lines up to a blank one. A block of code: up to its end.
    let stop = i + 1;
    while (stop < end && r[stop].kind === row.kind) stop++;
    const part = r.slice(i, stop), base = Math.min(...part.map((p) => p.indent));
    if (row.indent === 0) items = [];
    const body = row.kind === 'text' ? paraText(part) : part.map((p) => ' '.repeat(p.indent - base) + p.text).join('\n');
    // a line that is only a block's id ("^a1b2", under a table or a quote) is no block: Obsidian hides it
    if (!/^\^[A-Za-z0-9-]+$/.test(body.trim())) (row.indent > 0 && items.length ? items[items.length - 1].b : under()).kids.push({ text: clip(body), line: i, kids: [] });
    i = stop;
  }
}

/** One past the last line under the heading on line n: the next heading of its level or above. */
function sectionEnd(r: Row[], n: number): number {
  let i = n + 1;
  for (; i < r.length; i++) if (r[i].kind === 'heading' && r[i].level <= r[n].level) break;
  return i;
}

// ---------- properties ----------
const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/, '$2');
/** A value that is a path to a note, as OKF writes a relation: "../recipes/rye.md", "notes/a.md#part". */
export const RE_NOTE_PATH = /^(?:\.{1,2}\/|\/)?[^\s"'[\]|:#]+\.md(?:#\S+)?$/i;
const RE_TAG_VALUE = /^#?[\p{L}\p{N}_/-]+$/u;

/** One value of a property as Roam would hold it in an attribute: without YAML's quotes, a tag as a
 *  tag, a date as a link to that day's page, a path to a note as a link to it. */
function propOne(key: string, raw: string, okf = false): string {
  const v = unquote(raw.trim());
  if (!v) return '';
  if (/^tags?$/i.test(key)) return RE_TAG_VALUE.test(v) && !/^\d+$/.test(v) ? '#' + v.replace(/^#/, '') : v;
  // OKF's controlled words: a page per type and per status lists the notes that have it.
  if (okf && /^(type|status)$/.test(key) && !/[[\]]/.test(v)) return `[[${v}]]`;
  const day = isoToRoamDaily(v);
  if (day) return `[[${day}]]`;
  if (RE_NOTE_PATH.test(v)) return `[${v}](${v})`;
  return v;
}
/** A property's value: one value, or a list written on one line (`[a, b]`). */
export function propValue(key: string, raw: string, okf = false): string {
  const v = raw.trim();
  const list = /^\[(.*)\]$/.exec(v);
  if (list && !v.startsWith('[[')) return list[1].split(',').map((x) => propOne(key, x, okf)).filter(Boolean).join(/^tags?$/i.test(key) ? ' ' : ', ');
  return propOne(key, v, okf);
}
/** The properties of a note's frontmatter as attribute blocks ("name:: value"), a list or a map
 *  under a name as blocks under it. `end`: the line that closes the frontmatter, -1 without one. */
function propsOf(lines: string[], okf = false): { blocks: OutlineBlock[]; end: number } {
  const blocks: OutlineBlock[] = [];
  if (lines[0]?.replace(/\r$/, '') !== '---') return { blocks, end: -1 };
  const end = lines.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l));
  if (end < 0) return { blocks, end: -1 };
  let prop: OutlineBlock | null = null, key = '';
  for (let i = 1; i < end; i++) {
    const l = lines[i].replace(/\r$/, '');
    const m = /^([^\s:#-][^:]*?)\s*:(?:\s+(.*))?$/.exec(l);
    if (m) {
      key = unquote(m[1]);
      const value = m[2] ? propValue(key, m[2], okf) : '';
      blocks.push(prop = { text: `${key}::${value ? ' ' + value : ''}`, line: i, kids: [] });
    } else if (prop && l.trim()) {
      const item = l.trim().replace(/^-\s+/, '');
      const pair = /^([\w][\w .-]*?):\s+(.*)$/.exec(item); // a map in a list: "resource: notes/a.md"
      prop.kids.push({ text: pair ? `${pair[1]}: ${propValue(pair[1], pair[2], okf)}` : propValue(key, item, okf), line: i, kids: [] });
    }
  }
  return { blocks, end };
}

/** A whole note as an outline, the way Roam would hold it as a page: each property of its
 *  frontmatter an attribute block ("name:: value"), each heading a block with what follows it under
 *  it (a heading block's text keeps its #s), each list item a block nested by its indentation, each
 *  paragraph, quote, table or block of code a block. */
export function outlineOf(text: string, okf = false): OutlineBlock[] {
  const r = rows(text);
  const root: OutlineBlock = { text: '', line: -1, kids: [] };
  const lines = text.split('\n');
  const props = propsOf(lines, okf);
  root.kids.push(...props.blocks);
  const i = props.end + 1;
  fill(r, i, r.length, root, { n: Infinity });
  return root.kids;
}

/** What a vault gives for one line of a note that it read: the block the line is in. */
export type LineRead = Pick<LineContext, 'text' | 'line' | 'up' | 'kids' | 'cut'>;
/** A line of a page result, once read. `at` is the line its block starts on. */
export interface ReadLine { text: string; at?: number; up?: LineRead['up']; kids?: OutlineBlock[]; cut?: true }
/** Put what was read for a line into the line a page result has for it. */
export function putLine(l: ReadLine, t: LineRead) {
  l.text = t.text; l.at = t.line; l.up = t.up; l.kids = t.kids;
  if (t.cut) l.cut = true; else delete l.cut;
}

const headKey = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The line a link's subpath names in a note: "#Heading" (the last of "#H1#H2") a heading with that
 *  text, "#^id" the block that ends in " ^id" or, where the id is on a line of its own, the block
 *  above it. Undefined when the note has no such heading or block. */
export function lineOfSub(text: string, sub: string): number | undefined {
  const part = sub.slice(sub.lastIndexOf('#') + 1).trim();
  if (!part) return undefined;
  const lines = text.split('\n');
  if (part.startsWith('[^')) {
    // a footnote: the line that gives its text, "[^1]: text"
    const id = part.slice(2, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^ {0,3}\\[\\^${id}\\]:`);
    const i = lines.findIndex((l) => re.test(l));
    return i < 0 ? undefined : i;
  }
  if (part[0] === '^') {
    const id = part.slice(1);
    const re = new RegExp(`(?:^|[ \\t])\\^${id.replace(/[^A-Za-z0-9-]/g, '')}[ \\t]*\\r?$`);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      if (lines[i].trim() !== '^' + id) return i;
      for (let k = i - 1; k >= 0; k--) if (lines[k].trim()) return k;
      return i;
    }
    return undefined;
  }
  const want = headKey(part);
  for (let i = 0; i < lines.length; i++) {
    const m = RE_HEADING.exec(lines[i].replace(/\r$/, ''));
    if (m && headKey(m[2]) === want) return i;
  }
  return undefined;
}

/** Is a block's text nothing but links to pages? Roam's Linked References show such a block's
 *  children from the start, even when the block is closed in the graph (measured in Roam,
 *  2026-11-25): `[[A]]`, `#[[A]]`, `#A`, `[[A]] [[B]]`, with spaces and `.` `,` `:` `!` `+` `&` around
 *  them, are open; any other text (words, `TODO`, `**[[A]]**`, `-`, `;`, `?`, `[a]([[A]])`) keeps it
 *  closed. A note's `[[A|shown]]` is Roam's `[shown]([[A]])`, so it keeps it closed too; an
 *  Obsidian block id at the end is not text, nor a heading's #s. */
export function linksOnly(text: string): boolean {
  let links = 0;
  const rest = text
    .replace(/^#{1,6}[ \t]+/, '') // a heading: in Roam a block's heading is not its text
    .replace(/[ \t]\^[A-Za-z0-9-]+[ \t]*$/, '')
    .replace(/(?<!!)(?:#)?\[\[[^\]|\n]+\]\]/g, () => { links++; return ' '; })
    .replace(/(^|\s)#[\p{L}\p{N}_/-]+/gu, (m, s) => { links++; return s; });
  return links > 0 && /^[\s.,:!+&]*$/.test(rest);
}
