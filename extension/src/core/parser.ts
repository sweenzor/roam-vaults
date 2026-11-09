// Markdown note parser: frontmatter + links + tags + headings + block ids.
// Strategy: (1) one linear pass computes "dead" ranges (fenced code, inline
// code, %%comments%%, <!-- comments -->, $$math$$); (2) dead ranges are masked
// with \u0000 (newlines kept, so offsets/line numbers are preserved); (3) a few
// global regexes run over the masked text. No Node APIs.

import {
  type Link, type ParsedNote, type ParseOptions, type Heading,
  F_TRIMMED, F_ESCAPED_PIPE, F_RELATIVE, F_ABSOLUTE, F_DECODE_FAIL, F_UNQUOTED_YAML, F_HAS_MD_EXT, F_EMPTY_ALIAS, F_ANGLE,
} from './types.ts';
import { splitFrontmatter, extractAliases, extractFmTags } from './frontmatter.ts';

const NL = 10, BS = 92, BT = 96, PCT = 37, LT = 60, DOL = 36, TILDE = 126;

const RE_SPECIAL = /[\n\\`%<$]/g; // chars that can start a dead range (or a line)

/** Returns flat [start,end) pairs of regions that must not produce links/tags. */
export function deadRanges(text: string, from: number): number[] {
  const dead: number[] = [];
  const n = text.length;
  let i = from;
  let lineStart = true;
  while (i < n) {
    if (lineStart) {
      lineStart = false;
      // fence opener: optional blockquote markers / indentation, then ``` or ~~~
      let p = i;
      while (p < n) { const c = text.charCodeAt(p); if (c === 32 || c === 9 || c === 62 /* > */) p++; else break; }
      const fc = text.charCodeAt(p);
      if (fc === BT || fc === TILDE) {
        let q = p; while (q < n && text.charCodeAt(q) === fc) q++;
        const len = q - p;
        if (len >= 3) {
          let eol = text.indexOf('\n', q); if (eol < 0) eol = n;
          // backtick fences: info string may not contain backticks (else it's inline code)
          if (fc !== BT || text.indexOf('`', q) < 0 || text.indexOf('`', q) >= eol) {
            const end = findFenceClose(text, eol + 1, fc, len);
            dead.push(i, end);
            i = end; lineStart = true; continue;
          }
        }
      }
    }
    RE_SPECIAL.lastIndex = i;
    const sm = RE_SPECIAL.exec(text);
    if (!sm) break;
    i = sm.index;
    const c = text.charCodeAt(i);
    if (c === NL) { i++; lineStart = true; continue; }
    if (c === BS) { i += text.charCodeAt(i + 1) === NL ? 1 : 2; continue; }
    if (c === BT) {
      let q = i; while (q < n && text.charCodeAt(q) === BT) q++;
      const run = q - i;
      const close = findBacktickClose(text, q, run);
      if (close >= 0) { dead.push(i, close + run); i = close + run; } else i = q;
      continue;
    }
    if (c === PCT && text.charCodeAt(i + 1) === PCT) {
      const e = text.indexOf('%%', i + 2);
      const end = e < 0 ? n : e + 2;     // unclosed %% hides the rest (Obsidian behaviour)
      dead.push(i, end); i = end; continue;
    }
    if (c === LT && text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4);
      if (e >= 0) { dead.push(i, e + 3); i = e + 3; continue; }
      if (i === 0 || text.charCodeAt(i - 1) === NL) { dead.push(i, n); i = n; continue; }
    }
    if (c === DOL && text.charCodeAt(i + 1) === DOL) {
      const e = text.indexOf('$$', i + 2);
      if (e >= 0) { dead.push(i, e + 2); i = e + 2; continue; }
    }
    i++;
  }
  return dead;
}

function findFenceClose(text: string, p: number, fc: number, len: number): number {
  const n = text.length;
  while (p < n) {
    let eol = text.indexOf('\n', p); if (eol < 0) eol = n;
    let q = p;
    while (q < eol) { const c = text.charCodeAt(q); if (c === 32 || c === 9 || c === 62) q++; else break; }
    let r = q; while (r < eol && text.charCodeAt(r) === fc) r++;
    if (r - q >= len) {
      let s = r; while (s < eol && (text.charCodeAt(s) === 32 || text.charCodeAt(s) === 9 || text.charCodeAt(s) === 13)) s++;
      if (s === eol) return eol; // closing line consumed (newline stays live)
    }
    p = eol + 1;
  }
  return n; // unclosed fence runs to end of document (CommonMark)
}

function findBacktickClose(text: string, p: number, run: number): number {
  const n = text.length;
  while (p < n) {
    const c = text.charCodeAt(p);
    if (c === NL) {
      // a blank line ends the paragraph: no code span across it
      let q = p + 1; while (q < n && (text.charCodeAt(q) === 32 || text.charCodeAt(q) === 9 || text.charCodeAt(q) === 13)) q++;
      if (q >= n || text.charCodeAt(q) === NL) return -1;
      p++; continue;
    }
    if (c === BT) {
      let q = p; while (q < n && text.charCodeAt(q) === BT) q++;
      if (q - p === run) return p;
      p = q; continue;
    }
    p++;
  }
  return -1;
}

function mask(text: string, dead: number[]): string {
  if (dead.length === 0) return text;
  const parts: string[] = [];
  let last = 0;
  for (let k = 0; k < dead.length; k += 2) {
    const s = dead[k], e = dead[k + 1];
    parts.push(text.slice(last, s));
    parts.push(text.slice(s, e).replace(/[^\n]/g, '\u0000'));
    last = e;
  }
  parts.push(text.slice(last));
  return parts.join('');
}

// --- regexes (run on masked text) -----------------------------------------
const RE_WIKI = /(!?)\[\[([^\[\]\n\u0000]*)\]\]/g;
// [text](dest "title") — dest: <...> or no-space run with balanced single parens
const RE_MD = /(!?)\[((?:[^\[\]\n\u0000]|\[[^\[\]\n\u0000]*\])*)\]\(\s*(<[^<>\n\u0000]*>|(?:[^\s()\u0000]|\([^\s()\u0000]*\))*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;
// Obsidian tag: '#' then chars other than whitespace/punctuation (except _ - /); the preceding char (start/whitespace) is checked in code (lookbehind is ~5x slower)
const RE_TAG = /#([^\s!"#$%&'()*+,.:;<=>?@\[\]^`{|}~\\\u0000]+)/g;
const RE_BLOCKID = /\^([A-Za-z0-9-]+)[ \t]*\r?$/gm;
const RE_HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+([^\n]*)/gm;
const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 0xa0 || c === 0x3000;
const RE_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Copy a string so it no longer references its parent (V8 SlicedString >= 13 chars pins the parent). */
export function detach(s: string): string { return s.length < 13 ? s : (' ' + s).slice(1); }
const INTERN = new Map<string, string>();
/** Intern link targets: ~200k links share ~20k distinct targets. */
export function intern(s: string): string {
  let v = INTERN.get(s);
  if (v === undefined) { v = detach(s); if (INTERN.size > 500_000) INTERN.clear(); INTERN.set(v, v); }
  return v;
}

function lineIndex(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}
function lineOf(starts: number[], off: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
  return lo;
}
function snippetAt(text: string, starts: number[], line: number, col: number): string {
  const s = starts[line], e = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
  const lineText = text.slice(s, e).replace(/\r$/, '');
  if (lineText.length <= 100) return lineText.trim();
  const a = Math.max(0, col - 40);
  return (a > 0 ? '…' : '') + lineText.slice(a, a + 100).trim() + (a + 100 < lineText.length ? '…' : '');
}

/** Split "[[...]]" inner text into link fields (shared with frontmatter scanning). */
export function parseWikiInner(inner: string): { target: string; subpath: string; display: string | null; flags: number } {
  let flags = 0;
  const pipe = inner.indexOf('|');
  let tp = pipe < 0 ? inner : inner.slice(0, pipe);
  let display: string | null = pipe < 0 ? null : inner.slice(pipe + 1);
  if (tp.endsWith('\\')) { tp = tp.slice(0, -1); flags |= F_ESCAPED_PIPE; }
  if (display !== null && display.trim() === '') { flags |= F_EMPTY_ALIAS; display = null; }
  const hash = tp.indexOf('#');
  let target = hash < 0 ? tp : tp.slice(0, hash);
  const subpath = hash < 0 ? '' : tp.slice(hash).trim();
  const t = target.trim();
  if (t !== target) flags |= F_TRIMMED;
  target = t.normalize('NFC');
  if (target.startsWith('/')) flags |= F_ABSOLUTE;
  if (/\.md$/i.test(target)) flags |= F_HAS_MD_EXT;
  return { target: intern(target), subpath: subpath && intern(subpath), display: display && detach(display), flags };
}

function parseMdDest(dest: string): { target: string; subpath: string; flags: number } | null {
  let flags = 0;
  if (dest.startsWith('<')) { dest = dest.slice(1, -1); flags |= F_ANGLE; }
  dest = dest.trim();
  // external / obsidian:// / mailto: — also malformed "[x]((https://...))" seen in the wild
  if (dest === '' || RE_SCHEME.test(dest) || /^\(+[a-z][a-z0-9+.-]*:/i.test(dest)) return null;
  const hash = dest.indexOf('#');
  let path = hash < 0 ? dest : dest.slice(0, hash);
  let subpath = hash < 0 ? '' : dest.slice(hash);
  try { path = decodeURIComponent(path); subpath = decodeURIComponent(subpath); } catch { flags |= F_DECODE_FAIL; }
  if (path.startsWith('./') || path.startsWith('../')) flags |= F_RELATIVE;
  if (path.startsWith('/')) flags |= F_ABSOLUTE;
  if (/\.md$/i.test(path)) flags |= F_HAS_MD_EXT;
  return { target: intern(path.normalize('NFC')), subpath: subpath && intern(subpath), flags };
}

export function basenameNoMd(path: string): string {
  const slash = path.lastIndexOf('/');
  const b = slash < 0 ? path : path.slice(slash + 1);
  return /\.md$/i.test(b) ? b.slice(0, -3) : b;
}

export function parseNote(path: string, text: string, opts: ParseOptions = {}): ParsedNote {
  path = path.normalize('NFC');
  const fm = splitFrontmatter(text);
  const starts = lineIndex(text);
  const links: Link[] = [];

  // 1. links inside frontmatter values: "[[Target]]" (quoted or not)
  if (fm.raw !== null) {
    const fmLines = fm.raw.split('\n');
    let curKey = '';
    for (let li = 0; li < fmLines.length; li++) {
      const l = fmLines[li];
      const km = /^("[^"]*"|'[^']*'|[^\s:#-][^:]*?)\s*:/.exec(l);
      if (km) curKey = km[1].replace(/^["']|["']$/g, '');
      const lineNo = li + 1; // line 0 is '---'
      RE_WIKI.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RE_WIKI.exec(l))) {
        const before = l.slice(0, m.index);
        if (/(^|\s)#/.test(before.replace(/"[^"]*"|'[^']*'/g, ''))) break; // YAML comment
        const w = parseWikiInner(m[2]);
        const prevCh = l[m.index - 1];
        let flags = w.flags;
        if (prevCh !== '"' && prevCh !== "'" && !/["'][^"']*$/.test(before)) flags |= F_UNQUOTED_YAML;
        links.push({ kind: 'prop', embed: m[1] === '!', target: w.target, subpath: w.subpath, display: w.display,
          line: lineNo, col: m.index, flags, prop: intern(curKey),
          ...(opts.snippets ? { snippet: detach(l.trim().slice(0, 100)) } : {}) });
      }
    }
  }

  // 2. body
  const dead = deadRanges(text, fm.bodyStart);
  const masked = mask(text, dead);
  const push = (l: Link, off: number) => {
    l.line = lineOf(starts, off); l.col = off - starts[l.line];
    if (opts.snippets) l.snippet = detach(snippetAt(text, starts, l.line, l.col));
    links.push(l);
  };

  let m: RegExpExecArray | null;
  RE_WIKI.lastIndex = fm.bodyStart;
  while ((m = RE_WIKI.exec(masked))) {
    if (m[2].trim() === '') continue;
    const w = parseWikiInner(m[2]);
    push({ kind: 'wiki', embed: m[1] === '!', target: w.target, subpath: w.subpath, display: w.display, line: 0, col: 0, flags: w.flags }, m.index);
  }
  RE_MD.lastIndex = fm.bodyStart;
  while ((m = RE_MD.exec(masked))) {
    // skip "[[x]](y)" style overlaps: the char before '[' must not be '['
    if (m.index > 0 && masked.charCodeAt(m.index - 1) === 91 /* [ */) continue;
    const d = parseMdDest(m[3]);
    if (!d) continue;
    push({ kind: 'md', embed: m[1] === '!', target: d.target, subpath: d.subpath, display: detach(m[2]), line: 0, col: 0, flags: d.flags }, m.index);
  }

  const tagSet = new Set<string>();
  for (const t of extractFmTags(fm.props)) tagSet.add(t);
  RE_TAG.lastIndex = fm.bodyStart;
  while ((m = RE_TAG.exec(masked))) {
    if (m.index > 0 && !isWs(masked.charCodeAt(m.index - 1))) continue;
    const t = m[1].replace(/\/+$/, '');
    if (/^[0-9]+$/.test(t) || t === '') continue; // purely numeric is not a tag in Obsidian
    tagSet.add(intern(t.normalize('NFC')));
  }

  const headings: Heading[] = [];
  RE_HEADING.lastIndex = fm.bodyStart;
  while ((m = RE_HEADING.exec(masked))) {
    const raw = text.slice(m.index + m[0].length - m[2].length, m.index + m[0].length);
    headings.push({ level: m[1].length, text: detach(raw.replace(/\r$/, '').replace(/[ \t]+#+[ \t]*$/, '').trim()), line: lineOf(starts, m.index) });
  }
  const blockIds: string[] = [];
  RE_BLOCKID.lastIndex = fm.bodyStart;
  while ((m = RE_BLOCKID.exec(masked))) {
    if (m.index > 0 && !isWs(masked.charCodeAt(m.index - 1))) continue;
    blockIds.push(detach(m[1]));
  }

  return {
    path,
    title: basenameNoMd(path),
    aliases: extractAliases(fm.props),
    tags: [...tagSet],
    links, headings, blockIds,
    props: fm.props,
    fmError: fm.error,
    stats: { bytes: text.length, lines: starts.length, deadRanges: dead.length / 2 },
  };
}
