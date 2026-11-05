// Ranked matcher over a real or synthetic vault: band counts per title category, build cost
// and query latency. node --expose-gc src/harness/rank-check.ts <vault> [--fuzzy=false] [--show=cat]
import { walk, readAllSync } from './walk.ts';
import { parseNote } from '../core/parser.ts';
import { VaultIndex } from '../core/vault-index.ts';
import { NoteRanker } from '../core/ranker.ts';
import { synthRoamTitles } from './roam-titles.ts';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'))!;
const fuzzy = !args.includes('--fuzzy=false');
const show = args.find((a) => a.startsWith('--show='))?.slice(7);
const w = walk(dir);
const idx = new VaultIndex();
idx.build([...readAllSync(w.md).entries()].map(([p, s]) => parseNote(p, s)), w.other);
const gc = (globalThis as { gc?: () => void }).gc;
gc?.(); const h0 = process.memoryUsage().heapUsed;
let t = performance.now();
const r = new NoteRanker(idx, { dailyFormats: ['YYYY-MM-DD'], fuzzy });
const buildMs = performance.now() - t;
gc?.(); const heapMB = (process.memoryUsage().heapUsed - h0) / 2 ** 20;

const titles = synthRoamTitles(idx);
const byCat = new Map<string, { n: number; strong: number; medium: number; weak: number; none: number; ambiguous: number }>();
const lat: number[] = [];
for (const rep of [0, 1]) for (const { title, cat } of titles) {
  t = performance.now();
  const res = r.rank(title);
  const dt = performance.now() - t;
  if (!rep) continue;
  lat.push(dt);
  const c = byCat.get(cat) ?? { n: 0, strong: 0, medium: 0, weak: 0, none: 0, ambiguous: 0 };
  c.n++;
  if (!res.length) c.none++; else c[res[0].band]++;
  if (res[0]?.ambiguous) c.ambiguous++;
  byCat.set(cat, c);
  if (show === cat || show === 'all') console.log(`[${cat}] ${JSON.stringify(title)} -> ${res.slice(0, 3).map((x) => `${x.path} ${x.signal} ${x.score}${x.ambiguous ? ' ?' : ''}`).join(' | ') || '-'}`);
}
lat.sort((a, b) => a - b);
const q = (p: number) => lat[Math.floor(p * (lat.length - 1))].toFixed(3);
console.table(Object.fromEntries(byCat));
console.log(JSON.stringify({ notes: idx.notes.size, fuzzy, buildMs: Math.round(buildMs), heapMB: +heapMB.toFixed(1), p50ms: q(0.5), p95ms: q(0.95), maxMs: q(1) }));
