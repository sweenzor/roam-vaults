import { walk, readAllSync } from './walk.ts';
import { parseNote } from '../core/parser.ts';
import { VaultIndex } from '../core/vault-index.ts';
import { RoamMatcher } from '../core/matcher.ts';
import { synthRoamTitles } from './roam-titles.ts';
const w = walk(process.argv[2]);
const idx = new VaultIndex();
idx.build([...readAllSync(w.md).entries()].map(([p, s]) => parseNote(p, s)), w.other);
const m = new RoamMatcher(idx, { dailyFormats: ['YYYY-MM-DD'], loose: true });
const res: [number, string, number, number][] = [];
for (const rep of [0, 1]) for (const { title } of synthRoamTitles(idx)) { const t = performance.now(); const a = m.associations(title); const dt = performance.now() - t; if (rep) res.push([dt, title, a.notes.length, a.links.length]); }
res.sort((a, b) => b[0] - a[0]);
console.log(res.slice(0, 6).map(([d, t, n, l]) => `${d.toFixed(2)}ms  notes=${n} links=${l}  ${JSON.stringify(t)}`).join('\n'));
const big = [...idx.byName.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5).map(([k, v]) => `${k}: ${v.length}`);
console.log('largest basename buckets:', big);
