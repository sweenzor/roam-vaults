// Parse-only microbenchmark on preloaded strings, per-phase breakdown.
import { walk, readAllSync } from './walk.ts';
import { parseNote, deadRanges } from '../core/parser.ts';
import { splitFrontmatter } from '../core/frontmatter.ts';
const w = walk(process.argv[2]);
const texts = [...readAllSync(w.md).entries()];
const time = (label: string, f: () => void) => { f(); const t = performance.now(); f(); f(); console.log(label.padEnd(22), ((performance.now() - t) / 2).toFixed(1), 'ms'); };
time('frontmatter', () => { for (const [, s] of texts) splitFrontmatter(s); });
time('deadRanges', () => { for (const [, s] of texts) deadRanges(s, 0); });
const re = (r: RegExp) => () => { for (const [, s] of texts) { r.lastIndex = 0; while (r.exec(s)); } };
time('re wiki', re(/(!?)\[\[([^\[\]\n\u0000]*)\]\]/g));
time('re md', re(/(!?)\[((?:[^\[\]\n\u0000]|\[[^\[\]\n\u0000]*\])*)\]\(\s*(<[^<>\n\u0000]*>|(?:[^\s()\u0000]|\([^\s()\u0000]*\))*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g));
time('re tag', re(/(?<=^|\s)#([^\s!"#$%&'()*+,.:;<=>?@\[\]^`{|}~\\\u0000]+)/gm));
time('re heading', re(/^[ \t]{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*\r?$/gm));
time('re blockid', re(/(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*\r?$/gm));
time('parseNote total', () => { for (const [p, s] of texts) parseNote(p, s); });
