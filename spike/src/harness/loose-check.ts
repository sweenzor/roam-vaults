// Lists titles that only match via sanitized/ns-flat/loose tiers. node src/harness/loose-check.ts <vault>
import { walk, readAllSync } from './walk.ts';
import { parseNote } from '../core/parser.ts';
import { VaultIndex } from '../core/vault-index.ts';
import { RoamMatcher } from '../core/matcher.ts';
import { synthRoamTitles } from './roam-titles.ts';
const w = walk(process.argv[2]);
const idx = new VaultIndex();
idx.build([...readAllSync(w.md).entries()].map(([p, s]) => parseNote(p, s)), w.other);
const m = new RoamMatcher(idx, { dailyFormats: ['YYYY-MM-DD'], loose: true });
for (const { title, cat } of synthRoamTitles(idx)) for (const n of m.associations(title).notes) if (['loose', 'sanitized', 'ns-flat'].includes(n.how)) console.log(`${n.how.padEnd(9)} [${cat}] ${JSON.stringify(title)} -> ${n.path}`);
