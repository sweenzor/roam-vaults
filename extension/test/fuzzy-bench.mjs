// Fuzzy title matching: quality, latency and memory at N notes, on SQLite (the trigram table in
// src/sql/fuzzy.ts, what the extension uses) and on the in-memory fallback (src/core/fuzzy-index.ts,
// used only when SQLite can't load).
//
//   npm pack wordlist-english && tar xzf wordlist-english-*.tgz      (once, anywhere)
//   WORDS=path/to/package node --expose-gc test/fuzzy-bench.mjs [notes=20000]
//
// Titles are 1 to 4 English words (common words most often), some with a number, 15% daily-note
// dates, 15% of notes with an alias. Queries:
//   typo     one edit (swap, drop, add or change a letter, anywhere) in a word of 5+ letters
//   plural   an "s" added to or taken from the last word
//   order    two words swapped
//   unseen   a new title from the same generator that is in no note (any hit is a suggestion
//            the user didn't ask for; some are fair, like a plural, so samples are printed)
//   exact    a title that is a note (titles under 5 characters never match: by design)
import fs from 'node:fs';
import path from 'node:path';
import { fuzzyKey, judge } from '../src/core/fuzzy.ts';
import { FuzzyIndex } from '../src/core/fuzzy-index.ts';
import { VaultIndex, NONE } from '../src/core/vault-index.ts';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { FuzzyTitles } from '../src/sql/fuzzy.ts';
import { migrate } from '../src/sql/schema.ts';

const N = Number(process.argv[2] ?? 20000), Q = 1000;
const dir = process.env.WORDS;
if (!dir) { console.error('set WORDS to the unpacked wordlist-english package folder'); process.exit(1); }
const band = (b) => JSON.parse(fs.readFileSync(path.join(dir, `english-words-${b}.json`), 'utf8')).filter((w) => /^[a-z]+$/.test(w));
const W10 = band(10), W20 = band(20), W35 = band(35);

let s = 7;
const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const word = () => { const r = rnd(); return pick(r < 0.6 ? W10 : r < 0.9 ? W20 : W35); };
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const genTitle = () => {
  const k = 1 + Math.floor(rnd() * 4);
  let t = cap(word());
  for (let j = 1; j < k; j++) t += ' ' + word();
  if (rnd() < 0.15) t += ' ' + Math.floor(rnd() * 100);
  return t;
};

// ---------- vault ----------
const notes = [], keys = new Set();
for (let i = 0; i < Math.floor(N * 0.15); i++) notes.push({ path: `Daily/${new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10)}.md`, aliases: [] });
while (notes.length < N) {
  const t = genTitle(), z = fuzzyKey(t);
  if (keys.has(z)) continue;
  keys.add(z);
  notes.push({ path: `${pick(['', 'Notes/', 'Projects/', 'People/', 'Areas/Work/'])}${t}.md`, title: t, aliases: rnd() < 0.15 ? [genTitle()] : [] });
}
for (const n of notes) for (const a of n.aliases) keys.add(fuzzyKey(a));

// ---------- queries ----------
const named = notes.filter((n) => n.title);
const mutate = {
  typo(t) {
    const ws = t.split(' '), idx = ws.map((w, i) => (w.length >= 5 ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return null;
    const i = pick(idx), w = ws[i], p = Math.floor(rnd() * (w.length - 1)), r = rnd();
    const L = 'abcdefghijklmnopqrstuvwxyz'[Math.floor(rnd() * 26)];
    ws[i] = r < 0.25 ? w.slice(0, p) + w[p + 1] + w[p] + w.slice(p + 2)
      : r < 0.5 ? w.slice(0, p) + w.slice(p + 1)
      : r < 0.75 ? w.slice(0, p) + L + w.slice(p)
      : w.slice(0, p) + L + w.slice(p + 1);
    return ws.join(' ');
  },
  plural(t) { const ws = t.split(' '), l = ws.length - 1; if (/\d/.test(ws[l]) || ws[l].length < 4) return null; ws[l] = ws[l].endsWith('s') ? ws[l].slice(0, -1) : ws[l] + 's'; return ws.join(' '); },
  order(t) { const ws = t.split(' ').filter((w) => !/\d/.test(w)); if (ws.length < 2) return null; [ws[0], ws[1]] = [ws[1], ws[0]]; return ws.join(' ') + (/\d+$/.test(t) ? ' ' + t.match(/\d+$/)[0] : ''); },
};
const sets = {};
for (const [k, fn] of Object.entries(mutate)) {
  sets[k] = [];
  while (sets[k].length < Q) {
    const n = pick(named), q = fn(n.title);
    if (q && !keys.has(fuzzyKey(q))) sets[k].push({ q, want: n.path });
  }
}
sets.unseen = [];
while (sets.unseen.length < Q) { const q = genTitle(); if (!keys.has(fuzzyKey(q))) sets.unseen.push({ q, want: null }); }
sets.exact = Array.from({ length: Q }, () => { const n = pick(named); return { q: n.title, want: n.path }; });

// ---------- run ----------
const gc = globalThis.gc ?? (() => {});
const MB = (b) => (b / 1048576).toFixed(1);
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

function evaluate(name, m) {
  const out = {};
  for (const [k, qs] of Object.entries(sets)) {
    const times = [];
    let top1 = 0, any = 0, samples = [];
    for (const { q, want } of qs) {
      const t0 = performance.now(), hits = m.match(q);
      times.push(performance.now() - t0);
      if (hits.length) any++;
      if (want && hits[0]?.path === want) top1++;
      if (!want && hits.length && samples.length < 12) samples.push(`${q}  ->  ${hits[0].key ?? hits[0].path.replace(/^.*\//, "").slice(0, -3)} (sim ${hits[0].sim})`);
    }
    out[k] = { top1: qs[0].want ? top1 / qs.length : null, any: any / qs.length, p50: pct(times, 0.5), p95: pct(times, 0.95), max: Math.max(...times), samples };
  }
  console.log(`\n## ${name}`);
  console.log('set     found first   any hit   p50 ms   p95 ms   max ms');
  for (const [k, r] of Object.entries(out)) console.log(`${k.padEnd(7)} ${(r.top1 === null ? '-' : (r.top1 * 100).toFixed(1) + '%').padStart(11)} ${((r.any * 100).toFixed(1) + '%').padStart(9)} ${r.p50.toFixed(3).padStart(8)} ${r.p95.toFixed(3).padStart(8)} ${r.max.toFixed(2).padStart(8)}`);
  return out;
}

console.log(`# ${N} notes (${notes.length - named.length} daily), ${keys.size} distinct keys, ${Q} queries per set`);

// The index, on a VaultIndex as the extension builds it
gc(); gc();
let h0 = process.memoryUsage().heapUsed;
const idx = new VaultIndex();
idx.build(notes.map((n) => ({ path: n.path, size: 0, mtime: 0, aliases: n.aliases.length ? n.aliases : NONE, tags: NONE, links: NONE })), []);
gc(); gc();
const idxMB = process.memoryUsage().heapUsed - h0;
h0 = process.memoryUsage().heapUsed;
let t0 = performance.now();
const fx = new FuzzyIndex(idx);
const fxBuild = performance.now() - t0;
gc(); gc();
console.log(`\nVaultIndex of these notes: JS heap +${MB(idxMB)} MB`);
console.log(`FuzzyIndex: build ${fxBuild.toFixed(0)} ms; JS heap +${MB(process.memoryUsage().heapUsed - h0)} MB`);
t0 = performance.now();
for (const n of named.slice(0, 2000)) idx.upsertNote({ ...idx.notes.get(n.path) });
console.log(`update one note: ${((performance.now() - t0) / 2000 * 1000).toFixed(0)} µs (whole index, matcher listeners included)`);
evaluate('In-memory first-letter buckets (fallback when SQLite cannot load)', fx);

// SQLite, as the extension keeps it (the whole schema; only files and the fuzzy tables get rows)
const sqlite3 = await sqlite3InitModule();
const heap = () => sqlite3.wasm.heap8u().byteLength;
const heap0 = heap();
const db = new sqlite3.oo1.DB(':memory:');
migrate(db);
const size = () => db.selectValue('PRAGMA page_count') * db.selectValue('PRAGMA page_size');
db.exec('BEGIN');
const addFile = db.prepare('INSERT INTO files(path, name) VALUES (?, ?)');
for (const n of notes) { addFile.bind([n.path, '']).stepReset(); n.id = db.selectValue('SELECT last_insert_rowid()'); }
addFile.finalize();
db.exec('COMMIT');
const size0 = size();
const ft = new FuzzyTitles(db);
t0 = performance.now();
db.exec('BEGIN');
for (const n of notes) ft.put(n.id, n.path, n.aliases, true);
db.exec('COMMIT');
const buildMs = performance.now() - t0;
console.log(`\nSQLite ${sqlite3.version.libVersion}: first scan ${buildMs.toFixed(0)} ms (note by note, in one transaction, as a scan writes them); fuzzy tables ${MB(size() - size0)} MB of database (on OPFS only SQLite's 2 MB page cache stays in memory); wasm memory here ${MB(heap0)} -> ${MB(heap())} MB (database in memory)`);
t0 = performance.now();
for (const n of named.slice(0, 200)) ft.put(n.id, n.path, n.aliases);
console.log(`update one note (its own transaction): ${((performance.now() - t0) / 200).toFixed(2)} ms each`);
const sq = evaluate('SQLite trigram table (shipped)', ft);

console.log('\n## unseen titles that got a suggestion (SQLite), first 12');
for (const l of sq.unseen.samples) console.log('  ' + l);
db.close();
