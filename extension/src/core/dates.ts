// Daily-note mapping between Roam titles ("November 5th, 2026") and vault
// file names in a configurable moment.js-style format ("YYYY-MM-DD",
// "YYYY/MM/YYYY-MM-DD", "DD.MM.YYYY", "dddd, MMMM Do YYYY", ...). No Node APIs.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => (n < 10 ? '0' : '') + n;
const ord = (d: number) => d + (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th');

const RE_ROAM = /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})(?:st|nd|rd|th), (\d{4})$/;

/** "November 5th, 2026" -> "2026-11-05" (null if not a valid Roam daily title). */
export function roamDailyToIso(title: string): string | null {
  const m = RE_ROAM.exec(title.trim());
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1]) + 1, d = +m[2], y = +m[3];
  return validIso(y, mo, d);
}
export function isoToRoamDaily(iso: string): string {
  const [y, mo, d] = iso.split('-').map(Number);
  return `${MONTHS[mo - 1]} ${ord(d)}, ${y}`;
}
function validIso(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

type Tok = { re: string; set?: 'y' | 'm' | 'd' | 'yy'; map?: (s: string) => number };
const TOKENS: [string, Tok][] = [
  ['YYYY', { re: '(\\d{4})', set: 'y' }],
  ['YY', { re: '(\\d{2})', set: 'yy' }],
  ['MMMM', { re: `(${MONTHS.join('|')})`, set: 'm', map: (s) => MONTHS.findIndex((x) => x.toLowerCase() === s.toLowerCase()) + 1 }],
  ['MMM', { re: `(${MONTHS.map((x) => x.slice(0, 3)).join('|')})`, set: 'm', map: (s) => MONTHS.findIndex((x) => x.slice(0, 3).toLowerCase() === s.toLowerCase()) + 1 }],
  ['MM', { re: '(\\d{2})', set: 'm' }],
  ['M', { re: '(\\d{1,2})', set: 'm' }],
  ['Do', { re: '(\\d{1,2})(?:st|nd|rd|th)', set: 'd' }],
  ['DD', { re: '(\\d{2})', set: 'd' }],
  ['D', { re: '(\\d{1,2})', set: 'd' }],
  ['dddd', { re: `(?:${DAYS.join('|')})` }],
  ['ddd', { re: `(?:${DAYS.map((x) => x.slice(0, 3)).join('|')})` }],
];

export interface DateFormat { fmt: string; re: RegExp; groups: Tok[]; hasSlash: boolean }

export function compileFormat(fmt: string): DateFormat {
  let re = '', i = 0;
  const groups: Tok[] = [];
  outer: while (i < fmt.length) {
    // [text] is literal. A '[' that is never closed is an ordinary character.
    if (fmt[i] === '[') { const e = fmt.indexOf(']', i); if (e > i) { re += esc(fmt.slice(i + 1, e)); i = e + 1; continue; } }
    for (const [t, tok] of TOKENS) if (fmt.startsWith(t, i)) { re += tok.re; if (tok.set) groups.push(tok); i += t.length; continue outer; }
    re += esc(fmt[i]); i++;
  }
  return { fmt, re: new RegExp(`(?:^|/)${re}$`, 'i'), groups, hasSlash: fmt.includes('/') };
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parse a vault path (without .md) with a compiled format -> ISO date or null. */
export function parseWithFormat(pathNoExt: string, f: DateFormat): string | null {
  const m = f.re.exec(pathNoExt);
  if (!m) return null;
  let y = NaN, mo = NaN, d = NaN;
  f.groups.forEach((g, k) => {
    const raw = m[k + 1];
    const v = g.map ? g.map(raw) : +raw;
    if (g.set === 'y') y = v; else if (g.set === 'yy') y = 2000 + v; else if (g.set === 'm') mo = v; else if (g.set === 'd') d = v;
  });
  return validIso(y, mo, d);
}

export function formatIso(iso: string, fmt: string): string {
  const [y, mo, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const vals: Record<string, string> = {
    YYYY: String(y), YY: String(y).slice(2), MMMM: MONTHS[mo - 1], MMM: MONTHS[mo - 1].slice(0, 3), MM: pad(mo), M: String(mo),
    Do: ord(d), DD: pad(d), D: String(d), dddd: DAYS[dow], ddd: DAYS[dow].slice(0, 3),
  };
  let out = '', i = 0;
  outer: while (i < fmt.length) {
    if (fmt[i] === '[') { const e = fmt.indexOf(']', i); if (e > i) { out += fmt.slice(i + 1, e); i = e + 1; continue; } }
    for (const [t] of TOKENS) if (fmt.startsWith(t, i)) { out += vals[t]; i += t.length; continue outer; }
    out += fmt[i]; i++;
  }
  return out;
}
