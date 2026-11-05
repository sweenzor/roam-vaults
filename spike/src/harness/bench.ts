// usage: node --expose-gc src/harness/bench.ts <vaultDir> --name X [--snippets] [--truth file.json] [--daily FMT,...]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { walk, readAllSync, readAllAsync } from './walk.ts';
import { parseNote } from '../core/parser.ts';
import { VaultIndex, nfcLower } from '../core/vault-index.ts';
import { RoamMatcher } from '../core/matcher.ts';
import { synthRoamTitles } from './roam-titles.ts';
import type { ParsedNote } from '../core/types.ts';

const args = process.argv.slice(2);
const root = args[0];
const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const name = opt('--name', path.basename(root))!;
const snippets = args.includes('--snippets');
const truthFile = opt('--truth');
const dailyFormats = (opt('--daily', 'YYYY-MM-DD')!).split(',');
const gc = (globalThis as any).gc as (() => void) | undefined;
const now = () => performance.now();
const heap = async () => { for (let i = 0; i < 4; i++) { gc?.(); await new Promise((r) => setTimeout(r, 10)); } /x/.exec('reset RegExp.input'); gc?.(); return process.memoryUsage().heapUsed; };
const MB = (b: number) => +(b / 1048576).toFixed(1);
const r = (x: number, d = 1) => +x.toFixed(d);
const res: Record<string, unknown> = { name, snippets };

const heap0 = await heap();
let t = now();
const w = walk(root);
res.walkMs = r(now() - t);
res.mdFiles = w.md.length; res.otherFiles = w.other.length;

t = now();
let texts = readAllSync(w.md);
res.readSyncMs = r(now() - t);
let bytes = 0; for (const s of texts.values()) bytes += s.length;
res.textMB = MB(bytes);
t = now();
await readAllAsync(w.md, 32);
res.readAsync32Ms = r(now() - t);

// parse on preloaded strings (cold = first pass incl. JIT warmup)
const entries = [...texts.entries()];
t = now();
let parsed: ParsedNote[] = entries.map(([p, s]) => parseNote(p, s, { snippets }));
const parseCold = now() - t;
t = now();
parsed = entries.map(([p, s]) => parseNote(p, s, { snippets }));
const parseWarm = now() - t;
res.parseColdMs = r(parseCold); res.parseWarmMs = r(parseWarm);
res.parseFilesPerSec = Math.round(entries.length / (parseWarm / 1000));
res.parseMBPerSec = r(bytes / 1048576 / (parseWarm / 1000));

t = now();
const idx = new VaultIndex();
idx.build(parsed, w.other);
res.buildIndexMs = r(now() - t);
t = now();
const matcher = new RoamMatcher(idx, { dailyFormats, loose: true });
res.buildMatcherMs = r(now() - t);
res.totalColdIndexMs = r((res.readSyncMs as number) + (res.walkMs as number) + parseCold + (res.buildIndexMs as number) + (res.buildMatcherMs as number));

// ---- link stats
let links = 0, resolvedN = 0, unresolvedN = 0, ambiguous = 0, embeds = 0, toAttach = 0, props = 0, mdLinks = 0, selfLinks = 0;
let subHead = 0, subHeadBroken = 0, subBlock = 0, subBlockBroken = 0;
const brokenHeadingEx: string[] = [];
const normH = (s: string) => nfcLower(s).replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, a, b) => b ?? a)
  .replace(/[*_`=~]/g, '').replace(/[#|^:%\[\]\\]/g, ' ').replace(/\s+/g, ' ').trim();
const headSets = new Map<string, Set<string>>();
for (const recs of idx.outgoing.values()) for (const rec of recs) {
  links++;
  if (rec.link.embed) embeds++;
  if (rec.link.kind === 'prop') props++;
  if (rec.link.kind === 'md') mdLinks++;
  if (rec.link.target === '') selfLinks++;
  if (rec.resolved === null) { unresolvedN++; continue; }
  resolvedN++;
  if (rec.candidates > 1) ambiguous++;
  if (!/\.md$/i.test(rec.resolved)) toAttach++;
  const sp = rec.link.subpath;
  const tn = idx.notes.get(rec.resolved);
  if (!sp || !tn) continue;
  if (sp.startsWith('#^')) { subBlock++; if (!tn.blockIds.includes(sp.slice(2))) subBlockBroken++; }
  else {
    subHead++;
    let hs = headSets.get(tn.path);
    if (!hs) { hs = new Set(tn.headings.map((h) => normH(h.text))); headSets.set(tn.path, hs); }
    const last = sp.split('#').filter(Boolean).pop() ?? '';
    if (!hs.has(normH(last))) { subHeadBroken++; if (brokenHeadingEx.length < 12) brokenHeadingEx.push(`${rec.src} -> ${rec.link.target}${sp}`); }
  }
}
Object.assign(res, { links, resolved: resolvedN, unresolved: unresolvedN, unresolvedDistinctTargets: idx.unresolved.size, ambiguousResolved: ambiguous,
  embeds, linksToAttachments: toAttach, propLinks: props, mdLinks, selfLinks, headingSubpaths: subHead, headingSubpathsNotFound: subHeadBroken,
  blockSubpaths: subBlock, blockSubpathsNotFound: subBlockBroken, brokenHeadingExamples: brokenHeadingEx,
  aliases: idx.aliasIdx.size, distinctTags: idx.tagIdx.size, dailyNotesDetected: matcher.daily.size });

// ---- memory: drop texts, keep only index
texts = new Map(); entries.length = 0;
const heapIdx = await heap();
res.heapRetainedMB = MB(heapIdx - heap0);
res.maxRssMB = MB(process.resourceUsage().maxRSS * 1024);

// ---- serialization (warm-start cache)
t = now();
const json = JSON.stringify(idx.toJSON());
res.serializeMs = r(now() - t);
res.jsonMB = MB(json.length);
t = now();
const gz = zlib.gzipSync(json);
res.gzipMs = r(now() - t);
res.jsonGzipMB = MB(gz.length);
t = now();
const idx2 = VaultIndex.fromJSON(JSON.parse(json));
res.deserializeAndRebuildMs = r(now() - t);
void idx2;

// ---- queries
const titles = synthRoamTitles(idx);
const lat: number[] = [];
const tiers: Record<string, number> = {};
const byCat: Record<string, { n: number; hit: number }> = {};
let withAny = 0;
for (let rep = 0; rep < 3; rep++) for (const { title, cat } of titles) {
  const t0 = now();
  const a = matcher.associations(title);
  const dt = now() - t0;
  if (rep < 2) continue; // warm
  lat.push(dt);
  const hit = a.notes.length > 0 || a.links.length > 0 || a.tagged.length > 0;
  if (hit) withAny++;
  const c = (byCat[cat] ??= { n: 0, hit: 0 }); c.n++; if (hit) c.hit++;
  for (const n of a.notes) tiers[n.how] = (tiers[n.how] ?? 0) + 1;
  if (a.links.some((l) => l.via === 'unresolved')) tiers['links:unresolved'] = (tiers['links:unresolved'] ?? 0) + 1;
  if (a.links.some((l) => l.via === 'backlink')) tiers['links:backlink'] = (tiers['links:backlink'] ?? 0) + 1;
  if (a.tagged.length) tiers['tag'] = (tiers['tag'] ?? 0) + 1;
}
lat.sort((a, b) => a - b);
const q = (p: number) => r(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] * 1000, 1);
Object.assign(res, { roamTitles: titles.length, titlesWithAssociations: withAny, queryUsP50: q(0.5), queryUsP99: q(0.99), queryUsMax: q(1), tiers, byCat });
// also: badge every vault title + 20k Roam titles in one sweep
t = now();
let sweep = 0;
for (const n of idx.notes.values()) sweep += matcher.associations(n.title).links.length;
res.sweepAllVaultTitlesMs = r(now() - t);

// ---- incremental updates
const paths = [...idx.notes.keys()];
const pick = (k: number) => paths[(k * 7919) % paths.length];
const upd: number[] = [];
for (let k = 0; k < 200; k++) {
  const p = pick(k);
  const text = fs.readFileSync(path.join(root, w.md.find((m) => m.rel === p)!.rawName), 'utf8') + `\nedit [[Brand New Target ${k}]] #edited\n`;
  const t0 = now();
  idx.upsertNote(parseNote(p, text, { snippets }));
  upd.push(now() - t0);
}
upd.sort((a, b) => a - b);
res.incrUpdateUsP50 = r(upd[100] * 1000); res.incrUpdateUsMax = r(upd[199] * 1000);
// add a note that resolves the most common unresolved target
const topUnres = [...idx.unresolved.entries()].sort((a, b) => b[1].size - a[1].size)[0];
if (topUnres) {
  const tgt = [...topUnres[1]][0].link.target;
  t = now();
  const rer = idx.upsertNote(parseNote(`New/${tgt.split('/').pop()}.md`, 'new note'));
  res.incrAddResolvingMs = r(now() - t, 3); res.incrAddReResolvedLinks = rer; res.incrAddTarget = tgt;
  t = now();
  idx.removeFile(`New/${tgt.split('/').pop()}.md`);
  res.incrRemoveMs = r(now() - t, 3);
}

// ---- ground truth (synthetic vault)
if (truthFile) {
  const truth: { path: string; targets: string[] }[] = JSON.parse(fs.readFileSync(truthFile, 'utf8'));
  let ok = 0, bad = 0; const ex: string[] = [];
  const byPath = new Map(parsed.map((x) => [x.path, x]));
  for (const tr of truth) {
    const n = byPath.get(tr.path);
    const got = (n?.links ?? []).map((l) => l.target + l.subpath).sort();
    const want = tr.targets.slice().sort();
    if (JSON.stringify(got) === JSON.stringify(want)) ok++; else { bad++; if (ex.length < 5) ex.push(`${tr.path}: got ${got.length} want ${want.length} | ${got.filter((g) => !want.includes(g)).slice(0, 3)} / ${want.filter((g) => !got.includes(g)).slice(0, 3)}`); }
  }
  res.truth = { filesExact: ok, filesMismatch: bad, examples: ex };
}

fs.mkdirSync(path.join(import.meta.dirname, '../../out'), { recursive: true });
fs.writeFileSync(path.join(import.meta.dirname, `../../out/bench-${name}${snippets ? '-snip' : ''}.json`), JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
