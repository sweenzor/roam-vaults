// Reference-style Markdown links (CommonMark, so Obsidian's reading view and OKF): a link written
// `[text][ref]`, `[text][]` or `[ref]`, with its target given once, on a line of its own:
// `[ref]: target.md "title"`. Roam has no such form, so each use is read as the inline link
// `[text](target.md)` it stands for, and the line that defines it is hidden, as Obsidian hides it.

/** `[ref]: target "title"`, at most three spaces in. */
const RE_DEF = /^ {0,3}\[([^\[\]\n]*[^\[\]\s][^\[\]\n]*)\]:[ \t]*(<[^<>\n]*>|[^\s<>]+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\r?$/;
/** A use: `[text][ref]`, `[text][]`, or `[ref]` alone. The text may hold one level of brackets. */
const RE_USE = /\[((?:[^\[\]\n]|\[[^\[\]\n]*\])*)\](?:\[([^\[\]\n]*)\])?/g;

/** Labels match without regard to case or runs of white space, as CommonMark matches them. */
export const refKey = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();

/** The definition on one line, if it is one. */
export function refDef(line: string): { key: string; dest: string } | null {
  const m = RE_DEF.exec(line);
  return m ? { key: refKey(m[1]), dest: m[2] } : null;
}

/** Every definition of a note; the first of a label wins. `skip` tells lines that can't hold one
 *  (code, list items). */
export function refDefs(lines: string[], skip?: (i: number) => boolean): Map<string, string> {
  const defs = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(']:') || skip?.(i)) continue;
    const d = refDef(lines[i]);
    if (d && !defs.has(d.key)) defs.set(d.key, d.dest);
  }
  return defs;
}

export interface RefUse { index: number; end: number; text: string; dest: string }

/** The uses of defined labels in s, outside code spans. */
export function refUses(s: string, defs: Map<string, string>): RefUse[] {
  const out: RefUse[] = [];
  if (defs.size === 0 || !s.includes('[')) return out;
  const code = codeSpans(s);
  RE_USE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_USE.exec(s))) {
    const i = m.index, end = i + m[0].length;
    const before = s[i - 1], after = s[end];
    // part of [[a wikilink]], of an inline link's text or of something bigger: not a reference
    if (before === '[' || before === ']' || after === ']' || inCode(code, i)) continue;
    const label = m[2] === undefined || m[2] === '' ? m[1] : m[2];
    if (m[2] === undefined && (after === '(' || after === ':' || /[\[\]]/.test(label))) { RE_USE.lastIndex = i + 1; continue; }
    const dest = defs.get(refKey(label));
    if (dest === undefined || !refKey(label)) { if (m[2] !== undefined) RE_USE.lastIndex = i + 1; continue; }
    out.push({ index: i, end, text: m[1], dest });
  }
  return out;
}

/** s with each use written as the inline link it stands for. */
export function inlineRefs(s: string, defs: Map<string, string>): string {
  const uses = refUses(s, defs);
  if (!uses.length) return s;
  let out = '', last = 0;
  for (const u of uses) {
    const dest = u.dest.startsWith('<') || !/[\s()]/.test(u.dest) ? u.dest : `<${u.dest}>`;
    out += s.slice(last, u.index) + `[${u.text}](${dest})`;
    last = u.end;
  }
  return out + s.slice(last);
}

function codeSpans(s: string): number[] {
  const spans: number[] = [];
  if (!s.includes('`')) return spans;
  const re = /(`+)[^`]*?\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) spans.push(m.index, m.index + m[0].length);
  return spans;
}
function inCode(spans: number[], i: number): boolean {
  for (let k = 0; k < spans.length; k += 2) if (i >= spans[k] && i < spans[k + 1]) return true;
  return false;
}
