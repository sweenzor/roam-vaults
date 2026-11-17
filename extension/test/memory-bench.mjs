// Memory benchmark: loads an extension build in headless Chromium against a stand-in Roam page and a
// generated vault, and prints what the vault costs in the worker heap and in each browser process.
//
//   node test/memory-bench.mjs [notes=20000] [dist folder=dist]
//   DISK=1 node test/memory-bench.mjs ...     the vault is a real folder on disk
//
// Process numbers are private memory from /proc (Linux only), read without forcing a garbage
// collection, a few seconds after each step and again after a minute's idle. Without DISK=1 the vault
// lives in the browser's private file system. With it, the vault is written to a temporary folder and
// handed to the page the way a dropped folder is, so the handles, the reads and the file watcher are
// the ones a picked folder gets; it also checks a note whose name is not NFC on disk and a folder
// renamed while the vault is open. Either way this is not Roam's desktop app: compare two builds.
// See DEVELOPING.md.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const N = +(process.argv[2] ?? 20000);
const dist = path.resolve(process.argv[3] ?? path.join(import.meta.dirname, '../dist'));
const IDLE = +(process.env.IDLE_MS ?? 60000);
const DISK = !!process.env.DISK;
const VAULT = 'Big Vault';

// ---------- a deterministic vault: folders, frontmatter, links (some unresolved), tags, daily notes ----------
function gen(n, seed = 42) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const W = 'alpha beta gamma delta project meeting notes design review plan budget hiring research market customer product roadmap quarterly retro idea draft system memory index graph vault link neural garden reading book paper summary people team launch metric growth strategy pricing interview onboarding weekly daily journal travel recipe health finance music film history science math physics biology language writing essay thread question answer source quote concept model theory practice habit goal value'.split(' ');
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  const folders = [''];
  for (let i = 0; i < 150; i++) folders.push((rnd() < 0.5 ? cap(pick(W)) : cap(pick(W)) + '/' + cap(pick(W))) + (rnd() < 0.3 ? '/' + cap(pick(W)) : ''));
  const titles = [], seen = new Set();
  for (let i = 0; i < Math.floor(n * 0.15); i++) titles.push({ dir: 'Daily', t: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10) });
  while (titles.length < n) {
    const k = 1 + Math.floor(rnd() * 4); let t = cap(pick(W)); for (let j = 1; j < k; j++) t += ' ' + pick(W);
    if (rnd() < 0.5) t += ' ' + Math.floor(rnd() * 1000);
    if (seen.has(t.toLowerCase()) && rnd() < 0.97) continue;
    seen.add(t.toLowerCase());
    titles.push({ dir: pick(folders), t });
  }
  const sentence = () => { const k = 6 + Math.floor(rnd() * 14); let o = cap(pick(W)); for (let j = 1; j < k; j++) o += ' ' + pick(W); return o + '.'; };
  const link = () => {
    const r = rnd();
    if (r < 0.1) return `[[${cap(pick(W))} ${pick(W)} ${pick(W)} unwritten]]`;
    const t = titles[Math.floor(Math.pow(rnd(), 3) * titles.length)].t; // a few notes get most of the links
    return r < 0.2 ? `[[${t}|${pick(W)} ${pick(W)}]]` : r < 0.25 ? `[[${t}#${cap(pick(W))}]]` : `[[${t}]]`;
  };
  const files = new Map();
  for (const { dir, t } of titles) {
    let o = '';
    if (rnd() < 0.7) {
      o += '---\n';
      if (rnd() < 0.15) o += `aliases: [${cap(pick(W))} ${pick(W)}, ${pick(W)}]\n`;
      o += `tags: [${pick(W)}, ${pick(W)}/${pick(W)}]\n`;
      o += `created: 2024-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}T10:00:00\nupdated: 2025-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}T10:00:00\n`;
      o += `status: ${pick(['draft', 'done', 'evergreen', 'seedling'])}\nsource: https://example.com/${pick(W)}/${pick(W)}-${Math.floor(rnd() * 1e6)}\nauthor: "${cap(pick(W))} ${cap(pick(W))}"\n`;
      if (rnd() < 0.3) o += `related:\n  - "${link()}"\n  - "${link()}"\n`;
      if (rnd() < 0.3) o += `summary: ${sentence()} ${sentence()}\n`;
      o += '---\n';
    }
    o += `# ${t}\n\n`;
    const paras = Math.max(1, Math.floor(Math.exp(0.8 + rnd() * 2.2 + (rnd() < 0.03 ? 2 : 0)))); // about 3 KB a note, a few of 50 KB
    for (let p = 0; p < paras; p++) {
      if (p % 5 === 4) o += `## ${cap(pick(W))} ${pick(W)}\n\n`;
      if (rnd() < 0.5) { const k = 2 + Math.floor(rnd() * 5); for (let j = 0; j < k; j++) o += `- ${sentence()}${rnd() < 0.45 ? ' ' + link() : ''}${rnd() < 0.08 ? ' #' + pick(W) : ''}${rnd() < 0.03 ? ' ^blk' + Math.floor(rnd() * 1e5) : ''}\n`; o += '\n'; }
      else o += `${sentence()} ${rnd() < 0.5 ? link() + ' ' : ''}${sentence()} ${sentence()}${rnd() < 0.2 ? ' [' + pick(W) + '](https://example.com/' + pick(W) + ')' : ''}\n\n`;
    }
    files.set(`${dir ? dir + '/' : ''}${t}.md`, o);
  }
  for (let i = 0; i < Math.floor(n / 10); i++) files.set(`Attachments/${pick(W)}-${i}.png`, '');
  return files;
}

// ---------- server: the stand-in Roam page, the build under test, and a worker that writes the vault ----------
const html = `<!doctype html><meta charset=utf-8><title>stand-in for Roam</title>
<div class="roam-article"><h1 class="rm-title-display">Start</h1>
<div><div class="rm-reference-main">Linked References</div></div></div>`;
const seedWorker = `${gen}
onmessage = async ({ data: { n, name } }) => {
  const files = gen(n);
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
  const dirs = new Map([['', root]]);
  const enc = new TextEncoder();
  let bytes = 0, links = 0;
  for (const [rel, text] of files) {
    const i = rel.lastIndexOf('/'), dir = i < 0 ? '' : rel.slice(0, i);
    let d = dirs.get(dir);
    if (!d) { d = root; let at = ''; for (const s of dir.split('/')) { at = at ? at + '/' + s : s; let x = dirs.get(at); if (!x) dirs.set(at, x = await d.getDirectoryHandle(s, { create: true })); d = x; } }
    const h = await (await d.getFileHandle(rel.slice(i + 1), { create: true })).createSyncAccessHandle();
    const b = enc.encode(text); h.write(b); h.close();
    bytes += b.length; links += text.split('[[').length - 1;
  }
  postMessage({ files: files.size, bytes, links });
};`;
const server = http.createServer((req, res) => {
  const send = (type, body) => { res.setHeader('content-type', type); res.end(body); };
  if (req.url === '/') return send('text/html', html);
  if (req.url === '/seed-worker.js') return send('text/javascript', seedWorker);
  const f = path.join(dist, req.url);
  if (!fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
  send('text/javascript', fs.readFileSync(f));
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

// ---------- measuring ----------
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-bench-'));
const vaultDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-vault-')), VAULT);
const mb = (x) => Math.round(x / 104857.6) / 10;
/** Private memory of every process of the browser started on userDir. */
function procs() {
  const all = new Map();
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try { all.set(+pid, { cmd: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'), ppid: +fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ')[1] }); } catch { /* gone */ }
  }
  const rootPid = [...all].find(([, v]) => v.cmd.includes(userDir) && !v.cmd.includes('--type='))?.[0];
  const under = (pid) => { for (let x = pid, i = 0; x && i < 8; x = all.get(x)?.ppid, i++) if (x === rootPid) return true; return false; };
  const out = [];
  for (const [pid, { cmd }] of all) {
    if (!under(pid)) continue;
    try {
      const roll = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
      const kb = (k) => +(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(roll)?.[1] ?? 0);
      out.push({ pid, type: /--type=([\w-]+)/.exec(cmd)?.[1] ?? 'browser', priv: (kb('Private_Dirty') + kb('Private_Clean') + kb('Swap')) * 1024 });
    } catch { /* gone */ }
  }
  return out;
}
/** The V8 heap of the page's dedicated workers after a collection, through the DevTools protocol. */
async function workerHeap(ctx, p) {
  const s = await ctx.newCDPSession(p);
  const sessions = new Map(), waiting = new Map();
  let seq = 0;
  s.on('Target.attachedToTarget', (e) => sessions.set(e.sessionId, e.targetInfo));
  s.on('Target.receivedMessageFromTarget', (e) => { const m = JSON.parse(e.message); waiting.get(m.id)?.(m); waiting.delete(m.id); });
  await s.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
  const sendTo = (sessionId, method) => new Promise((res) => { const id = ++seq; waiting.set(id, res); s.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method }) }).catch(() => res({})); });
  await new Promise((r) => setTimeout(r, 200));
  let used = 0;
  for (const [sid, info] of sessions) {
    if (info.type !== 'worker') continue;
    await sendTo(sid, 'HeapProfiler.collectGarbage');
    const r = (await sendTo(sid, 'Runtime.getHeapUsage')).result;
    if (r) used += r.usedSize + (r.embedderHeapUsedSize ?? 0) + (r.backingStorageSize ?? 0);
  }
  await s.detach().catch(() => {});
  return used;
}
const rows = [];
let base = null;
/** Sample the processes for `ms`, keep the highest total seen, and report where they end up. */
async function settle(p, phase, ms = 6000) {
  let peak = 0, ps = procs();
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    await p.waitForTimeout(500);
    ps = procs();
    peak = Math.max(peak, ps.reduce((a, x) => a + x.priv, 0));
  }
  const renderer = ps.filter((x) => x.type === 'renderer').reduce((a, x) => a + x.priv, 0);
  const browser = ps.find((x) => x.type === 'browser')?.priv ?? 0;
  const total = ps.reduce((a, x) => a + x.priv, 0);
  const row = { phase, rendererMB: mb(renderer), browserMB: mb(browser), allMB: mb(total) };
  if (base) Object.assign(row, { extraMB: mb(total - base.total), peakExtraMB: mb(Math.max(peak, peaks) - base.total) });
  else base = { total };
  peaks = 0;
  rows.push(row);
  console.log(JSON.stringify(row));
  return row;
}
let peaks = 0; // highest total since the last row, sampled while a step runs
const watch = setInterval(() => { peaks = Math.max(peaks, procs().reduce((a, x) => a + x.priv, 0)); }, 500);

// ---------- driving the page ----------
const launch = () => chromium.launchPersistentContext(userDir, { env: { ...process.env, LC_ALL: 'C.UTF-8' } });
async function openPage(ctx) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  p.on('crash', () => console.log('[crash]'));
  await p.goto(url);
  return p;
}
/** A handle for the folder on disk, as the page gets one for a folder dropped on it. */
async function dropVault(ctx, p) {
  await p.evaluate(() => {
    window.__dropped = new Promise((res, rej) => {
      document.addEventListener('dragover', (e) => e.preventDefault());
      document.addEventListener('drop', (e) => { e.preventDefault(); e.dataTransfer.items[0].getAsFileSystemHandle().then(res, rej); }, { once: true });
    });
  });
  const s = await ctx.newCDPSession(p);
  const data = { items: [], files: [vaultDir], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await s.send('Input.dispatchDragEvent', { type, x: 50, y: 50, data });
  await s.detach();
  await p.evaluate(async () => { window.__vault = await window.__dropped; });
}
async function loadExtension(ctx, p) {
  if (DISK) await dropVault(ctx, p);
  await p.evaluate(async (name) => {
    // a handle read back from IndexedDB crashes headless Chromium, so the vault always comes through the picker
    await new Promise((r) => { const q = indexedDB.deleteDatabase('roam-vaults'); q.onsuccess = q.onerror = q.onblocked = r; });
    const vault = window.__vault ?? await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    window.showDirectoryPicker = async () => vault;
    // count the vault walks: each one reports "indexing" first
    window.__walks = 0;
    const W = window.Worker;
    window.Worker = class extends W { constructor(...a) { super(...a); this.addEventListener('message', ({ data }) => { if (data?.type === 'status' && data.state === 'indexing' && data.detail === 'reading files') window.__walks++; }); } };
    window.__title = 'Start';
    window.roamAlphaAPI = { ui: { mainWindow: { getOpenPageOrBlockUid: async () => 'uid' } }, pull: () => ({ ':node/title': window.__title }) };
    window.__effects = [];
    window.React = { createElement: (t, props) => ({ t, props }), useRef: () => (window.__ref = { current: null }), useEffect: (fn) => window.__effects.push(fn) };
    window.__ext = (await import('/extension.js')).default;
    await window.__ext.onload({ extensionAPI: { settings: { panel: { create: (cfg) => { window.__settings = cfg; } } } } });
    const box = document.createElement('div'); box.id = 'settings-box'; document.body.append(box);
    window.__settings.settings[0].action.component(); window.__ref.current = box; window.__effects.forEach((fn) => fn());
  }, VAULT);
}
const press = (p, label) => p.evaluate((label) => [...document.querySelectorAll('#settings-box button')].find((b) => b.textContent === label).click(), label);
async function indexed(p) {
  const t0 = Date.now();
  await p.waitForTimeout(500);
  await p.waitForFunction(() => /^\d+ notes?/.test(document.querySelector('#settings-box .rv-settings-status')?.textContent ?? ''), null, { timeout: 900000, polling: 250 });
  return Date.now() - t0 + 500;
}
const visit = (p, title) => p.evaluate(async (title) => {
  window.__title = title; window.dispatchEvent(new HashChangeEvent('hashchange'));
  const t0 = performance.now();
  while (document.querySelector('.rv-panel')?.dataset.title !== title && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 800));
  return document.querySelector('.rv-sec-head strong')?.textContent ?? '';
}, title);

// ---------- 1. write the vault, in a browser of its own ----------
let ctx, p, seeded;
// Checked in the disk run: a note whose name is not NFC on disk, and folders that appear, move and go
// away while the vault is open, none of which should walk the whole vault again.
const NFD_NOTE = 'Re\u0301sume\u0301s/2026/Cafe\u0301 plan.md', MOVED_DIR = 'Moved later', MOVED_TO = 'Moved now';
if (DISK) {
  const files = gen(N);
  files.set(NFD_NOTE, 'the line of the decomposed note [[Disk name check]]\n');
  files.set(`${MOVED_DIR}/Deep/Kept.md`, 'the line of the moved note [[Folder move check]]\n');
  seeded = { files: files.size, bytes: 0, links: 0 };
  const made = new Set();
  for (const [rel, text] of files) {
    const f = path.join(vaultDir, rel), d = path.dirname(f);
    if (!made.has(d)) { fs.mkdirSync(d, { recursive: true }); made.add(d); }
    fs.writeFileSync(f, text);
    seeded.bytes += Buffer.byteLength(text); seeded.links += text.split('[[').length - 1;
  }
} else {
  ctx = await launch();
  p = await openPage(ctx);
  seeded = await p.evaluate(({ n, name }) => new Promise((res, rej) => {
    const w = new Worker('/seed-worker.js');
    w.onmessage = ({ data }) => { w.terminate(); res(data); };
    w.onerror = (e) => rej(new Error(e.message));
    w.postMessage({ n, name });
  }), { n: N, name: VAULT });
  await ctx.close();
}
console.log(`vault${DISK ? ' on disk' : ''}: ${seeded.files} files, ${mb(seeded.bytes)} MB of text, ${seeded.links} links`);

// ---------- 2. first index, in a fresh browser ----------
ctx = await launch();
p = await openPage(ctx);
await settle(p, 'page without the extension');
await loadExtension(ctx, p);
await press(p, 'Add vault folder');
console.log(`first index took ${await indexed(p)} ms`);
console.log(`status: ${await p.evaluate(() => document.querySelector('#settings-box .rv-settings-status')?.textContent)}`);
await settle(p, 'first index: just finished');
await settle(p, 'first index: idle', IDLE);
await ctx.close();

// ---------- 3. a later start, from the cache, in a fresh browser ----------
ctx = await launch();
p = await openPage(ctx);
base = null;
await settle(p, 'page without the extension');
await loadExtension(ctx, p);
await press(p, 'Add vault folder');
console.log(`start from the cache took ${await indexed(p)} ms`);
await settle(p, 'later start: just finished');
await settle(p, 'later start: idle', IDLE);

const titles = ['Alpha', 'Meeting notes', 'Budget', 'Design', 'Project', 'Research', 'Hiring', 'Roadmap', 'Notes', 'Idea'];
const ordinal = (d) => d + (d % 100 > 10 && d % 100 < 14 ? 'th' : ['th', 'st', 'nd', 'rd'][d % 10] ?? 'th');
for (let i = 0; i < 30; i++) { const d = new Date(Date.UTC(2021, 0, 1) + i * 86400000); titles.push(`${d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })} ${ordinal(d.getUTCDate())}, ${d.getUTCFullYear()}`); }
const heads = {};
for (const t of titles) heads[t] = await visit(p, t);
console.log(`visited ${titles.length} pages, ${Object.values(heads).filter(Boolean).length} with references`);
await settle(p, 'after visiting 40 pages');
// Page lookup times, straight from the workers, where the build exports them.
const timing = await p.evaluate(async (titles) => {
  const ext = window.__ext, out = {};
  const time = async (fn, n) => {
    const xs = [];
    for (let i = 0; i < n; i++) { const t0 = performance.now(); await fn(i); xs.push(performance.now() - t0); }
    xs.sort((a, b) => a - b);
    return { medianMs: +xs[xs.length >> 1].toFixed(1), p95Ms: +xs[Math.floor(xs.length * 0.95)].toFixed(1) };
  };
  if (ext.query) out.pageQuery = await time((i) => ext.query(titles[i % titles.length]), 80);
  return out;
}, titles);
console.log(JSON.stringify(timing));

for (let i = 0; i < 15; i++) { // each edit is followed by a cache write
  if (DISK) fs.writeFileSync(path.join(vaultDir, `Scratch ${i % 3}.md`), `edit ${i} links [[Alpha]], [[Budget]] and [[Live edit check]]\n`);
  else await p.evaluate(async ({ i, name }) => {
    const v = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    const w = await (await v.getFileHandle(`Scratch ${i % 3}.md`, { create: true })).createWritable();
    await w.write(`edit ${i} links [[Alpha]], [[Budget]] and [[Live edit check]]\n`); await w.close();
  }, { i, name: VAULT });
  await p.waitForTimeout(3000);
}
await settle(p, 'after 15 note edits');
const editSeen = await visit(p, 'Live edit check'); // a page only the edited notes link to
console.log(`edits seen without a rescan: ${editSeen === '3 External Vault References'} (${editSeen || 'nothing shown'})`);

if (DISK) {
  const lines = () => p.evaluate(() => document.querySelector('.rv-panel')?.textContent ?? '');
  await visit(p, 'Disk name check');
  console.log(`a note whose name is not NFC on disk shows its line: ${(await lines()).includes('the line of the decomposed note')}`);
  const walks = () => p.evaluate(() => window.__walks);
  const walked = await walks();
  /** Change the vault on disk, then wait until the page shows the line or stops showing it. */
  async function folderCheck(what, change, line, shown = true) {
    await visit(p, 'Folder move check');
    const t0 = Date.now();
    change();
    let ok = false;
    while (!ok && Date.now() - t0 < 15000) { await visit(p, 'Start'); await visit(p, 'Folder move check'); ok = (await lines()).includes(line) === shown; }
    console.log(`${what}: ${ok ? `${shown ? 'shows' : 'drops'} its line after ${Date.now() - t0} ms` : 'FAILED'}`);
    return ok;
  }
  await visit(p, 'Folder move check');
  console.log(`before folder changes, the note in "${MOVED_DIR}" shows its line: ${(await lines()).includes('the line of the moved note')}`);
  await folderCheck('a folder renamed while open', () => fs.renameSync(path.join(vaultDir, MOVED_DIR), path.join(vaultDir, MOVED_TO)), `${MOVED_TO}/Deep`);
  await folderCheck('a new folder with notes written into it', () => {
    fs.mkdirSync(path.join(vaultDir, 'Agent run/Step 1'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'Agent run/Step 1/Log.md'), 'the line of a new folder [[Folder move check]]\n');
  }, 'the line of a new folder');
  const outside = path.join(path.dirname(vaultDir), 'outside');
  fs.mkdirSync(path.join(outside, 'Copied/Deep'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'Copied/Deep/Inside.md'), 'the line of a folder moved in [[Folder move check]]\n');
  await folderCheck('a folder moved in from outside the vault', () => fs.renameSync(path.join(outside, 'Copied'), path.join(vaultDir, 'Copied')), 'the line of a folder moved in');
  await folderCheck('a folder deleted', () => fs.rmSync(path.join(vaultDir, 'Agent run'), { recursive: true }), 'the line of a new folder', false);
  await folderCheck('a folder moved into .trash', () => { fs.mkdirSync(path.join(vaultDir, '.trash'), { recursive: true }); fs.renameSync(path.join(vaultDir, 'Copied'), path.join(vaultDir, '.trash/Copied')); }, 'the line of a folder moved in', false);
  console.log(`whole-vault walks for those folder changes: ${(await walks()) - walked}`);
}

await press(p, 'Rescan');
console.log(`rescan took ${await indexed(p)} ms`);
await settle(p, 'after a rescan');
await settle(p, 'end: idle', IDLE);
const heap = await workerHeap(ctx, p);
const stored = await p.evaluate(async () => {
  // The origin private file system's files under .roam-vaults (the SQLite builds' databases).
  let bytes = 0;
  const walk = async (d) => { for await (const [, h] of d.entries()) bytes += h.kind === 'file' ? (await h.getFile()).size : 0, h.kind === 'directory' && await walk(h); };
  try { await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('.roam-vaults')); } catch { /* none */ }
  return { idb: (await navigator.storage.estimate()).usageDetails?.indexedDB ?? 0, opfs: bytes };
});
console.log(JSON.stringify({ workerHeapMB: mb(heap), cacheMB: mb(stored.idb), sqliteFilesMB: mb(stored.opfs) }));
console.log(JSON.stringify({ heads }));
clearInterval(watch);
await ctx.close(); server.close();
fs.rmSync(userDir, { recursive: true, force: true });
fs.rmSync(path.dirname(vaultDir), { recursive: true, force: true });
