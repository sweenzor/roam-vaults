// Stepwise retained-heap breakdown. node --expose-gc src/harness/heap-steps.ts <vault> [--snippets]
import { walk, readAllSync } from './walk.ts';
import { parseNote } from '../core/parser.ts';
import { VaultIndex } from '../core/vault-index.ts';
import { RoamMatcher } from '../core/matcher.ts';
const gc = (globalThis as any).gc;
const heap = async () => { for (let i = 0; i < 4; i++) { gc(); await new Promise((r) => setTimeout(r, 10)); } /x/.exec('reset RegExp.input'); gc(); return process.memoryUsage().heapUsed / 1048576; };
const w = walk(process.argv[2]);
const h0 = await heap();
let texts: Map<string, string> | null = readAllSync(w.md);
const h1 = await heap();
const parsed = [...texts.entries()].map(([p, s]) => parseNote(p, s, { snippets: process.argv.includes('--snippets') }));
texts = null;
const h2 = await heap();
const idx = new VaultIndex(); idx.build(parsed, w.other);
const h3 = await heap();
const m = new RoamMatcher(idx, { dailyFormats: ['YYYY-MM-DD'], loose: true });
const h4 = await heap();
let links = 0; for (const n of parsed) links += n.links.length;
console.log({ textsMB: +(h1 - h0).toFixed(1), parsedNotesMB: +(h2 - h0).toFixed(1), indexMapsMB: +(h3 - h2).toFixed(1), matcherMB: +(h4 - h3).toFixed(1), totalMB: +(h4 - h0).toFixed(1),
  bytesPerLink_parsed: Math.round((h2 - h0) * 1048576 / links), sets: { backlinks: idx.backlinks.size, byLinkName: idx.byLinkName.size, unresolved: idx.unresolved.size, sanitized: m.sanitized.size, loose: m.loose.size, tag: idx.tagIdx.size } });
