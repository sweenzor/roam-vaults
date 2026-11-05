// Print associations for a few Roam titles. node src/harness/demo.ts <vault> "Title" ...
import { walk, readAllSync } from './walk.ts';
import { parseNote } from '../core/parser.ts';
import { VaultIndex } from '../core/vault-index.ts';
import { RoamMatcher } from '../core/matcher.ts';
const [root, ...titles] = process.argv.slice(2);
const w = walk(root);
const idx = new VaultIndex();
idx.build([...readAllSync(w.md).entries()].map(([p, s]) => parseNote(p, s, { snippets: true })), w.other);
const m = new RoamMatcher(idx, { dailyFormats: ['YYYY-MM-DD'] });
for (const t of titles) {
  const a = m.associations(t);
  console.log(`\n"${t}": notes=${JSON.stringify(a.notes)} links=${a.links.length} tagged=${a.tagged.length}`);
  for (const l of a.links.slice(0, 2)) console.log(`   ${l.via} ${l.kind}${l.embed ? '!' : ''} ${l.src}:${l.line + 1} -> ${l.resolvedTo ?? '(unresolved)'} | ${l.snippet}`);
}
