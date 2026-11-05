// Generates a synthetic Obsidian vault with ground truth.
// usage: node src/harness/gen-synthetic.ts <outDir> [notes=20000] [seed=42]
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
const N = +(process.argv[3] ?? 20000);
let seed = +(process.argv[4] ?? 42);
if (!out) throw new Error('outDir required');
fs.rmSync(out, { recursive: true, force: true });

function rnd() { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];

const WORDS = ('time person year way day thing man world life hand part child eye woman place work week case point government company number group problem fact ' +
  'idea system program question night story money book research network theory model design market energy garden river memory signal pattern habit ' +
  'project review meeting strategy budget roadmap release feature bug customer interview hiring onboarding retro planning metric insight reading ' +
  'quantum neural graph vector matrix entropy protocol kernel compiler cache index parser schema query cluster latency throughput').split(' ');
const UNI = ['café', 'naïve', 'Zürich', 'São Paulo', '東京', 'Москва', 'Ελλάδα', 'smörgåsbord', 'crème brûlée', '😀 Mood', '🚀 Launch', 'Ærøskøbing', 'Đà Nẵng', 'İstanbul', 'résumé'];
const cap = (w: string) => w[0].toUpperCase() + w.slice(1);

function title(): string {
  if (rnd() < 0.04) return `${pick(UNI)} ${cap(pick(WORDS))}`;
  const n = ri(1, 4);
  const ws = Array.from({ length: n }, () => pick(WORDS));
  ws[0] = cap(ws[0]);
  return ws.join(' ') + (rnd() < 0.15 ? ' ' + ri(1, 999) : '');
}

const FOLDERS: string[] = [];
const TOP = ['Projects', 'Areas', 'Resources', 'Archive', 'People', 'Meetings', 'Reading', 'Zettel', 'Inbox', 'Work', 'Personal', 'Research'];
for (const t of TOP) { FOLDERS.push(t); for (let k = 0; k < 3; k++) { const s = `${t}/${cap(pick(WORDS))}`; FOLDERS.push(s); if (rnd() < 0.5) FOLDERS.push(`${s}/${cap(pick(WORDS))}`); } }

interface Note { path: string; title: string; headings: string[]; blocks: string[]; aliases: string[] }
const notes: Note[] = [];
const used = new Set<string>();
// daily notes ~1100
const dailyCount = Math.min(1100, Math.floor(N * 0.055));
const start = Date.UTC(2023, 0, 1);
for (let d = 0; d < dailyCount; d++) {
  const iso = new Date(start + d * 86400000).toISOString().slice(0, 10);
  notes.push({ path: `Daily/${iso}.md`, title: iso, headings: ['Log'], blocks: [], aliases: [] });
}
while (notes.length < N) {
  let t = title();
  const dup = rnd() < 0.02 && notes.length > dailyCount + 10;
  if (dup) t = notes[ri(dailyCount, notes.length - 1)].title; // duplicate basename in another folder
  else if (used.has(t.toLowerCase())) continue;
  used.add(t.toLowerCase());
  const folder = pick(FOLDERS);
  const p = `${folder}/${t}.md`;
  if (notes.some((x) => x.path === p) && dup) continue;
  const headings = Array.from({ length: ri(1, 4) }, (_, k) => `${cap(pick(WORDS))} ${pick(WORDS)} ${k}`);
  notes.push({ path: p, title: t, headings, blocks: [], aliases: rnd() < 0.1 ? [`${cap(pick(WORDS))} ${pick(WORDS)} alias ${notes.length}`] : [] });
}
const GHOSTS = Array.from({ length: 2000 }, () => title() + ' ghost');
const ATTACH = Array.from({ length: 500 }, (_, k) => `Attachments/img-${k}.${pick(['png', 'jpg', 'pdf', 'svg'])}`);
const regular = notes.slice(dailyCount);

const truth: { path: string; targets: string[] }[] = [];
let bytes = 0, nfd = 0;
function para(len: number): string {
  const ws: string[] = [];
  let l = 0;
  while (l < len) { const w = pick(WORDS); ws.push(w); l += w.length + 1; }
  return cap(ws.join(' ')) + '.';
}

for (const n of notes) {
  const targets: string[] = [];
  const parts: string[] = [];
  // frontmatter
  if (rnd() < 0.5) {
    const fm: string[] = ['---'];
    fm.push(`tags: [${pick(WORDS)}, ${pick(WORDS)}/${pick(WORDS)}]`);
    if (n.aliases.length) fm.push('aliases:', ...n.aliases.map((a) => `  - "${a}"`));
    if (rnd() < 0.2) { const r = pick(regular); fm.push(`related: "[[${r.title}]]"`); targets.push(r.title); }
    fm.push(`created: 2025-0${ri(1, 9)}-1${ri(0, 9)}`);
    fm.push('---');
    parts.push(fm.join('\n'));
  }
  const size = Math.exp(Math.log(500) + rnd() * (Math.log(5000) - Math.log(500)));
  const nLinks = ri(5, 15);
  const linkTexts: string[] = [];
  for (let k = 0; k < nLinks; k++) {
    const r = rnd();
    const tn = pick(regular);
    let s: string;
    if (r < 0.50) { s = `[[${tn.title}]]`; targets.push(tn.title); }
    else if (r < 0.60) { s = `[[${tn.title}|${pick(WORDS)} ${pick(WORDS)}]]`; targets.push(tn.title); }
    else if (r < 0.67) { const h = pick(tn.headings); s = `[[${tn.title}#${h}]]`; targets.push(`${tn.title}#${h}`); }
    else if (r < 0.70) { s = `[[${tn.title}#^blk-${k}]]`; targets.push(`${tn.title}#^blk-${k}`); }
    else if (r < 0.74) { const a = pick(ATTACH); const b = a.slice(a.lastIndexOf('/') + 1); s = `![[${b}]]`; targets.push(b); }
    else if (r < 0.78) { s = `[${pick(WORDS)}](${encodeURIComponent(tn.title)}.md)`; targets.push(`${tn.title}.md`); }
    else if (r < 0.81) { const pp = tn.path.slice(0, -3); s = `[[${pp}]]`; targets.push(pp); }
    else if (r < 0.96) { const g = pick(GHOSTS); s = `[[${g}]]`; targets.push(g); }
    else { const d = notes[ri(0, dailyCount - 1)].title; s = `[[${d}]]`; targets.push(d); }
    linkTexts.push(s);
  }
  for (const h of n.headings) {
    parts.push(`## ${h}`);
    const nPara = ri(1, 3);
    for (let q = 0; q < nPara; q++) {
      let p = para(size / (n.headings.length * 2));
      if (linkTexts.length && rnd() < 0.8) {
        const take = linkTexts.splice(0, ri(1, 4));
        const ws = p.split(' ');
        for (const lt of take) ws.splice(ri(0, ws.length), 0, lt);
        p = ws.join(' ');
      }
      if (rnd() < 0.2) p += ` ^blk-${q}`;
      parts.push(p);
    }
  }
  if (linkTexts.length) parts.push('- ' + linkTexts.join('\n- '));
  // decoys that must NOT be extracted
  if (rnd() < 0.2) parts.push('```js\nconst x = "[[Decoy In Fence]]"; // #notatag\n```');
  if (rnd() < 0.1) parts.push('Use `[[Decoy Inline]]` syntax.');
  if (rnd() < 0.05) parts.push('%% hidden [[Decoy Comment]] %%');
  if (rnd() < 0.03) parts.push('<!-- [[Decoy Html]] -->');
  const text = parts.join('\n\n') + '\n';
  let rel = n.path;
  if (/[^\x00-\x7f]/.test(rel) && rnd() < 0.3) { rel = rel.normalize('NFD'); nfd++; } // macOS-style NFD names
  const abs = path.join(out, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  bytes += Buffer.byteLength(text);
  truth.push({ path: n.path.normalize('NFC'), targets: targets.map((t) => t.normalize('NFC')) });
}
for (const a of ATTACH) { const abs = path.join(out, a); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'x'); }
fs.writeFileSync(path.join(path.dirname(out), 'synthetic-truth.json'), JSON.stringify(truth));
console.log(JSON.stringify({ notes: notes.length, attachments: ATTACH.length, MB: +(bytes / 1e6).toFixed(1), nfdNames: nfd, folders: FOLDERS.length }));
