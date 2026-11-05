// Packs a vault into one JSON file so the browser bench can seed OPFS. node src/harness/make-bundle.ts <vault> <out.json>
import fs from 'node:fs';
import { walk, readAllSync } from './walk.ts';
const w = walk(process.argv[2]);
const t = readAllSync(w.md);
fs.writeFileSync(process.argv[3], JSON.stringify({ md: w.md.map((f) => ({ p: f.rawName, t: t.get(f.rel) })), other: w.other }));
console.log(w.md.length, 'md files');
