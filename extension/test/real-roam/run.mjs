// End-to-end run of the built extension in Roam's real desktop app (the Linux build, under Xvfb),
// signed in to a hosted test graph. Drives Roam over the Chrome DevTools Protocol with Playwright.
//
//   DISPLAY=:99 ROAM_EMAIL=… ROAM_PASSWORD=… node test/real-roam/run.mjs
//
// Checks what the browser smoke test can't: the extension loads through Roam Depot's developer mode,
// its settings tab works, a vault folder on disk shows up on a real Roam page and updates live, a
// large vault stays within memory limits through scans and Rescans, and a scan that crashed Roam
// isn't repeated on the next start. Writes RESULTS.md, a memory log and PNG screenshots to $OUT.
//
// Credentials come only from the environment (GitHub Actions secrets in CI). They are removed from
// this process's environment before anything else starts, never written to disk or to the log, and
// no screenshot is taken before the graph is open. See .github/workflows/real-roam.yml.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { genVault } from './genvault.mjs';

const require = createRequire(import.meta.url);
const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;

const GRAPH = process.env.ROAM_GRAPH || 'vault-spike-hosted';
const APP_URL = 'https://roamresearch.com/?server-port=3333#/app';
const ROAM_BIN = process.env.ROAM_BIN || 'roam-research';
const CDP_PORT = 9222, SERVE_PORT = 8766;
const EXT_URL = `http://127.0.0.1:${SERVE_PORT}/ci/`;
const DIST = path.resolve(process.env.DIST || path.join(import.meta.dirname, '../../dist'));
const OUT = path.resolve(process.env.OUT || 'real-roam-out');
const NOTES = +(process.env.NOTES || 20000);
const TEST_PAGE = 'Vaults CI test';
const SMALL = 'CI Vault', BIG = 'Big Vault';
// MB the extension adds over Roam without it. PR #16 measured 193 / 89 / 168 / 235 / 383 at 20,000
// notes on Roam 0.0.42 (Linux); 0.1.0 measured 466 / 325 / 827 / 1,389 / 2,698.
const LIMITS = {
  coldPeak: +(process.env.LIMIT_COLD_PEAK_MB || 350),
  settled: +(process.env.LIMIT_SETTLED_MB || 175),
  rescanPeak: +(process.env.LIMIT_RESCAN_PEAK_MB || 350),
  rescanChangedPeak: +(process.env.LIMIT_RESCAN_CHANGED_PEAK_MB || 450),
  rescan5Peak: +(process.env.LIMIT_RESCAN5_PEAK_MB || 700),
};

fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'real-roam-'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- results ----------
const checks = [], memRows = [], memLog = [];
let signedIn = false, shotN = 0;
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); log(ok ? 'PASS' : 'FAIL', name, detail); };
function writeResults(extra = '') {
  const pass = checks.length > 0 && checks.every((c) => c.ok) && !extra;
  const roamVersion = (() => { try { return execFileSync('dpkg-query', ['-W', '-f=${Version}', 'roam-research'], { encoding: 'utf8' }); } catch { return '?'; } })();
  const md = [
    `# Real Roam run: ${pass ? 'PASS' : 'FAIL'}`, '',
    `Roam desktop ${roamVersion} (Linux, Xvfb), hosted graph \`${GRAPH}\`, large vault of ${NOTES.toLocaleString('en-US')} notes on disk.`,
    `Commit ${process.env.GITHUB_SHA?.slice(0, 7) ?? 'local'}.`, '',
    extra ? `**Stopped early:** ${extra}\n` : '',
    '| Check | Result |', '|---|---|',
    ...checks.map((c) => `| ${c.name}${c.detail ? ` (${c.detail})` : ''} | ${c.ok ? 'PASS' : '**FAIL**'} |`), '',
    memRows.length ? '## Memory (MB added by the extension over Roam without it)\n' : '',
    memRows.length ? '| Step | MB | Limit |\n|---|---|---|' : '',
    ...memRows.map((r) => `| ${r.step} | ${r.mb} | ${r.limit ?? ''} |`), '',
    'Memory is the private memory (dirty + clean + swap) of every Roam process from /proc, sampled every 0.5 s.',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'RESULTS.md'), md + '\n');
  fs.writeFileSync(path.join(OUT, 'memory.log'), memLog.join('\n') + '\n');
  return pass;
}

// ---------- memory ----------
function roamPids() {
  return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((pid) => {
    try { return /Roam Research|roam-research/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')); } catch { return false; }
  });
}
function roamMB() {
  let kb = 0;
  for (const pid of roamPids()) {
    try {
      const r = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
      for (const k of ['Private_Dirty', 'Private_Clean', 'Swap']) kb += +(r.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
    } catch { /* process went away */ }
  }
  return kb / 1024;
}
/** Sample for `ms`; returns peak and the mean of the samples from `settleFrom` ms on. */
async function sample(label, ms, settleFrom = ms - 15000) {
  const t0 = Date.now(); let peak = 0; const tail = [];
  while (Date.now() - t0 < ms) {
    const m = roamMB(), t = Date.now() - t0;
    peak = Math.max(peak, m); if (t >= settleFrom) tail.push(m);
    memLog.push(`${label}\t${(t / 1000).toFixed(1)}\t${m.toFixed(0)}`);
    await sleep(500);
  }
  const mean = tail.reduce((a, b) => a + b, 0) / Math.max(1, tail.length);
  log(`mem ${label}: peak ${peak.toFixed(0)} MB, settled ${mean.toFixed(0)} MB`);
  return { peak, mean };
}
let baseline = 0;
function memRow(step, mb, limit) {
  const added = Math.round(mb - baseline);
  memRows.push({ step, mb: added, limit });
  if (limit) check(`Memory: ${step} under ${limit} MB`, added <= limit, `${added} MB`);
}

// ---------- extension server (Roam Depot developer extension from URL) ----------
const server = http.createServer((q, s) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Allow-Headers': '*', 'Cache-Control': 'no-store' };
  if (q.method === 'OPTIONS') { s.writeHead(204, h); return s.end(); }
  const rel = decodeURIComponent(q.url.split('?')[0]).replace(/^\/ci\//, '');
  const f = path.join(DIST, rel);
  if (!f.startsWith(DIST) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { s.writeHead(404, h); return s.end(); }
  h['Content-Type'] = f.endsWith('.js') ? 'text/javascript' : f.endsWith('.md') ? 'text/markdown' : 'text/plain';
  s.writeHead(200, h); s.end(q.method === 'HEAD' ? undefined : fs.readFileSync(f));
}).listen(SERVE_PORT, '127.0.0.1');

// ---------- Roam ----------
const roamEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ROAM_|GITHUB_TOKEN|ACTIONS_)/.test(k)));
let browser = null, page = null;
async function launchRoam() {
  const out = fs.openSync(path.join(WORK, 'roam.log'), 'a'); // kept out of $OUT: Roam's own log isn't ours to publish
  spawn(ROAM_BIN, ['--no-sandbox', `--remote-debugging-port=${CDP_PORT}`], { env: roamEnv, detached: true, stdio: ['ignore', out, out] }).unref();
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      if (list.some((t) => t.type === 'page' && t.url.includes('roamresearch.com'))) break;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctx = browser.contexts()[0];
  for (let i = 0; i < 30 && !page; i++) {
    page = ctx.pages().find((p) => p.url().includes('roamresearch.com') && !p.url().includes('sw.js')) ?? null;
    if (!page) await sleep(1000);
  }
  if (!page) throw new Error('Roam window not found over CDP');
  // Only the extension's own messages and page errors; Roam's console is not ours to publish.
  page.on('console', (m) => { if (m.text().includes('[roam-vaults]')) log('[page]', m.text().slice(0, 300)); });
  page.on('pageerror', (e) => { if (/vault|rv-/i.test(e.stack ?? e.message)) log('[pageerror]', e.message.slice(0, 300)); });
  await page.setViewportSize?.({ width: 1200, height: 773 }).catch(() => {});
}
async function killRoam(signal = 'SIGKILL') {
  try { await browser?.close(); } catch { /* already gone */ }
  browser = null; page = null;
  for (const pid of roamPids()) { try { process.kill(+pid, signal); } catch { /* gone */ } }
  for (let i = 0; i < 30 && roamPids().length; i++) await sleep(500);
  for (const pid of roamPids()) { try { process.kill(+pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(1000);
}
async function waitFor(label, fn, timeout = 30000, every = 250) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last; } catch { /* page navigating */ }
    await sleep(every);
  }
  throw new Error(`timed out after ${timeout / 1000} s waiting for ${label}`);
}
async function shot(name) {
  if (!signedIn || !page) return; // never photograph the sign-in screen
  const f = path.join(OUT, `${String(++shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f }).catch((e) => log('screenshot failed', e.message));
}
const evalIn = (fn, arg) => page.evaluate(fn, arg);

async function signIn() {
  const form = await waitFor('the sign-in form or a graph', () => evalIn(() =>
    document.querySelector('input[name="password"], input[type="password"]') ? 'form'
      : document.querySelector('.roam-app, .rm-graph-list, .roam-body') || /HOSTED GRAPHS/i.test(document.body.innerText) ? 'in' : null), 90000);
  if (form === 'in') { log('already signed in'); return; }
  if (!EMAIL || !PASSWORD) throw new Error('ROAM_EMAIL and ROAM_PASSWORD are not set');
  let step = 'email';
  try {
    await page.fill('input[name="email"], input[type="email"]', EMAIL);
    step = 'password';
    await page.focus('input[name="password"], input[type="password"]');
    await page.keyboard.insertText(PASSWORD);
    step = 'Sign In button';
    await page.locator('button', { hasText: /^Sign In$/ }).first().click();
  } catch (e) {
    // only the first line, with the credentials blanked: Playwright's call log can quote input
    const why = e.message.split('\n')[0].split(EMAIL).join('***').split(PASSWORD).join('***');
    throw new Error(`could not fill in the sign-in form (${step}): ${why}`);
  }
  await waitFor('sign-in to finish', () => evalIn(() => !document.querySelector('input[type="password"]')), 60000)
    .catch(() => { throw new Error('sign-in failed: check the ROAM_EMAIL and ROAM_PASSWORD secrets'); });
  log('signed in');
}
async function openGraph() {
  if (!page.url().includes(`#/app/${GRAPH}`)) await page.goto(`${APP_URL}/${GRAPH}`);
  await waitFor(`graph ${GRAPH} to load`, () => evalIn(() => {
    if (/error loading your graph/i.test(document.body.innerText)) throw new Error('graph error');
    return !!(window.roamAlphaAPI?.data?.q && document.querySelector('.roam-main .roam-article, .roam-main .roam-log-container, .rm-title-display'));
  }), 180000);
  signedIn = true;
  await dismissDialogs();
  log('graph open');
}
async function dismissDialogs() {
  for (let i = 0; i < 3; i++) {
    if (!(await evalIn(() => !!document.querySelector('.bp3-dialog, .bp3-overlay-open')))) return;
    await page.keyboard.press('Escape'); await sleep(500);
  }
}
async function openTestPage() {
  await dismissDialogs();
  await evalIn(async (title) => {
    const api = window.roamAlphaAPI;
    const exists = api.data.q('[:find ?u . :in $ ?t :where [?p :node/title ?t] [?p :block/uid ?u]]', title);
    if (!exists) await api.data.page.create({ page: { title } });
    await api.ui.mainWindow.openPage({ page: { title } });
  }, TEST_PAGE);
  await waitFor('the test page', () => evalIn((t) => document.querySelector('.roam-article .rm-title-display')?.textContent.trim() === t, TEST_PAGE), 20000);
}

// ---------- Settings dialog ----------
const clickLeaf = (text, scope = '.bp3-dialog') => evalIn(([text, scope]) => {
  const el = [...document.querySelectorAll(`${scope} *`)].find((e) => e.children.length === 0 && e.textContent.trim() === text);
  el?.click(); return !!el;
}, [text, scope]);
async function openSettings() {
  if (await evalIn(() => !!document.querySelector('.bp3-dialog .rm-settings, .bp3-dialog'))) return;
  const more = page.locator('.rm-topbar .bp3-icon-more').first();
  if (await more.count()) await more.click(); else await page.mouse.click(1088, 22);
  await waitFor('the More menu', () => evalIn(() => !!document.querySelector('.bp3-menu-item')), 5000);
  await evalIn(() => [...document.querySelectorAll('.bp3-menu-item')].find((e) => /^Settings/.test(e.innerText.trim()))?.click());
  await waitFor('the Settings dialog', () => evalIn(() => !!document.querySelector('.bp3-dialog')), 10000);
}
async function openVaultsTab() {
  if (await evalIn(() => !!document.querySelector('.rv-settings'))) return;
  await openSettings();
  await waitFor('the "Vaults (dev)" settings tab', () => clickLeaf('Vaults (dev)'), 20000);
  await waitFor('the vault list', () => evalIn(() => !!document.querySelector('.rv-settings')), 10000);
}
/** Clicks the icon button `name` (cog, link, ...) in the Roam Depot section header that reads `label`. */
async function clickHeaderIcon(label, name) {
  const btn = page.locator('.bp3-dialog .rm-extensions-installed__header', { hasText: label }).locator(`button.bp3-icon-${name}`).first();
  await btn.waitFor({ timeout: 10000 });
  // the header moves for a moment while Roam Depot lays out, so wait until it stays put
  let last = null;
  for (let i = 0; i < 20; i++) {
    const box = await btn.boundingBox();
    if (box && last && box.x === last.x && box.y === last.y) break;
    last = box; await sleep(150);
  }
  await btn.click();
}
async function loadDevExtension() {
  await openSettings();
  if (await clickLeaf('Vaults (dev)')) { log('developer extension already loaded'); return; }
  await waitFor('Roam Depot in Settings', () => clickLeaf('Roam Depot'), 10000);
  await waitFor('the Roam Depot settings', () => evalIn(() => /Installed Extensions/.test(document.querySelector('.bp3-dialog')?.innerText ?? '')), 15000);
  if (!(await evalIn(() => /Developer Extensions/.test(document.querySelector('.bp3-dialog')?.innerText ?? '')))) {
    await clickHeaderIcon('Installed Extensions', 'cog');
    await waitFor('"Enable developer mode"', () => clickLeaf('Enable developer mode', '.bp3-popover'), 5000);
    await waitFor('the Developer Extensions row', () => evalIn(() => /Developer Extensions/.test(document.querySelector('.bp3-dialog')?.innerText ?? '')), 5000);
  }
  await clickHeaderIcon('Developer Extensions', 'link');
  const input = page.locator('input[placeholder^="Something like"]');
  await input.waitFor({ timeout: 5000 });
  await input.fill(EXT_URL);
  await sleep(500); // an instant click after typing loads nothing: Roam's input state lags a moment
  await page.locator('.bp3-dialog button', { hasText: 'Load remote extension' }).click();
  await waitFor('"Vaults (dev)" in Settings', () => evalIn(() =>
    [...document.querySelectorAll('.bp3-dialog *')].some((e) => e.children.length === 0 && e.textContent.trim() === 'Vaults (dev)')), 30000);
  await dismissDialogs();
}
const vaultRows = () => evalIn(() => Object.fromEntries([...document.querySelectorAll('.rv-settings-row')].map((r) => [
  r.querySelector('.rv-settings-name')?.firstChild?.textContent.trim(), {
    status: r.querySelector('.rv-settings-status')?.textContent.trim(),
    buttons: [...r.querySelectorAll('button')].map((b) => b.innerText.trim()),
  }])));
const statusOf = async (name) => (await vaultRows())[name]?.status ?? '';
async function clickButton(text, rowName = null) {
  const n = await evalIn(([text, rowName]) => {
    const scope = rowName ? [...document.querySelectorAll('.rv-settings-row')].find((r) => r.querySelector('.rv-settings-name')?.firstChild?.textContent.trim() === rowName)
      : document.querySelector('.rv-settings-actions');
    const b = [...(scope?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === text);
    b?.click(); return b ? 1 : 0;
  }, [text, rowName]);
  if (!n) throw new Error(`no "${text}" button${rowName ? ` in the ${rowName} row` : ''}`);
}
/** Hands Roam a real folder on disk the way a drop does, then answers the folder picker with it. */
async function addVault(dir) {
  await openVaultsTab();
  await evalIn(() => {
    window.__ciDrop = new Promise((res, rej) => {
      const over = (e) => e.preventDefault();
      document.addEventListener('dragover', over, true);
      document.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation(); document.removeEventListener('dragover', over, true);
        e.dataTransfer.items[0].getAsFileSystemHandle().then(res, rej);
      }, { once: true, capture: true });
    });
  });
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [dir], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: 600, y: 600, data });
  await cdp.detach();
  const got = await evalIn(async () => {
    const h = await window.__ciDrop; const orig = window.showDirectoryPicker;
    window.showDirectoryPicker = async () => { window.showDirectoryPicker = orig; return h; };
    return `${h.kind} ${h.name}`;
  });
  log('dropped', got);
  await clickButton('Add vault folder');
}
async function clearExtensionState() {
  // Only matters when the same Roam profile is reused (a fresh CI runner has none of this). If the
  // extension is already loaded it holds its databases open, so remove its vaults through settings.
  await openSettings();
  if (await clickLeaf('Vaults (dev)')) {
    await waitFor('the vault list', () => evalIn(() => !!document.querySelector('.rv-settings')), 10000);
    for (let i = 0; i < 20 && (await evalIn(() => document.querySelectorAll('.rv-settings-row').length)); i++) {
      await evalIn(() => [...document.querySelector('.rv-settings-row').querySelectorAll('button')].find((b) => b.innerText.trim() === 'Remove')?.click());
      await sleep(500);
    }
    log('removed vaults left by an earlier run');
  }
  await dismissDialogs();
  await evalIn(async () => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('roam-vaults')) localStorage.removeItem(k);
    for (const db of ['roam-vaults', 'roam-vaults-cache', 'roam-vaults-marks']) await new Promise((r) => { const q = indexedDB.deleteDatabase(db); q.onsuccess = q.onerror = q.onblocked = r; });
  });
}
/** Is the vault's scan mark set? It's in localStorage, or (since the crash-mark fix) in IndexedDB. */
const scanMarked = (id) => evalIn(async (id) => {
  if (localStorage.getItem(`roam-vaults:scanning:${id}`) !== null) return true;
  // never open a database that doesn't exist yet: that would create it without its store
  if (!(await indexedDB.databases()).some((d) => d.name === 'roam-vaults-marks')) return false;
  const db = await new Promise((res, rej) => { const r = indexedDB.open('roam-vaults-marks'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  try {
    if (!db.objectStoreNames.contains('scanning')) return false;
    return await new Promise((res) => { const q = db.transaction('scanning').objectStore('scanning').get(id); q.onsuccess = () => res(q.result != null); q.onerror = () => res(false); });
  } finally { db.close(); }
}, id);
const touchAll = (dir) => { const t = new Date(); for (const f of fs.readdirSync(dir, { recursive: true })) { const p = path.join(dir, f); if (fs.statSync(p).isFile()) fs.utimesSync(p, t, t); } };
const panelText = () => evalIn(() => document.querySelector('.roam-article .rv-panel')?.innerText ?? '');

// ---------- the run ----------
async function main() {
  if (!fs.existsSync(path.join(DIST, 'extension.js'))) throw new Error(`no build in ${DIST}: run npm run build first`);
  // vaults first, so writing them doesn't disturb the memory numbers
  const small = path.join(WORK, SMALL), big = path.join(WORK, BIG);
  const smallFiles = {
    [`${TEST_PAGE}.md`]: `# ${TEST_PAGE}\nThe note for this page. See [[CI linked note]].\n`,
    'Notes/CI linked note.md': `Mentions [[${TEST_PAGE}]] in a backlink line.\n`,
    'Daily/2026-01-02.md': `- met about [[${TEST_PAGE}|the CI page]]\n`,
    '.obsidian/app.json': '{}',
  };
  for (const [rel, text] of Object.entries(smallFiles)) { fs.mkdirSync(path.dirname(path.join(small, rel)), { recursive: true }); fs.writeFileSync(path.join(small, rel), text); }
  const gen = genVault(NOTES, big);
  log(`generated ${BIG}: ${gen.files} files, ${gen.mb} MB`);

  await launchRoam();
  await signIn();
  await openGraph();
  await clearExtensionState();
  await openTestPage();
  await sleep(5000);
  baseline = (await sample('baseline-no-extension', 20000, 5000)).mean;
  memRows.push({ step: `Roam without the extension (absolute)`, mb: Math.round(baseline) });

  // load through Roam Depot developer mode
  await loadDevExtension();
  check('Extension loads through Roam Depot developer mode', true);
  await openTestPage();
  await sleep(2000);
  check('Nothing on the page before a vault is added', (await panelText()).trim() === '');

  // small vault: function
  await addVault(small);
  await waitFor(`${SMALL} to finish scanning`, async () => /^3 notes$/.test(await statusOf(SMALL)), 30000)
    .catch(async (e) => { check('Small vault scans', false, await statusOf(SMALL)); throw e; });
  check('Vault list shows the new vault and its note count', true, '3 notes');
  await shot('settings-one-vault');
  await openTestPage();
  const t1 = await waitFor('External Vault References on the page', async () => { const t = await panelText(); return t.includes('External Vault References') && t; }, 15000).catch(() => '');
  check('External Vault References shows on a real Roam page', t1.includes('3 External Vault References'), t1.split('\n')[0]);
  check('Counterpart note listed first', (await evalIn(() => document.querySelector('.roam-article .rv-panel .rv-note')?.textContent.trim()))?.endsWith(TEST_PAGE)); // "CI Vault/…" once there are two vaults
  check('Backlink line shown', t1.includes('Mentions') && t1.includes('backlink line'));
  check('Panel sits below Linked References', await evalIn(() => {
    const refs = document.querySelector('.roam-article .rm-reference-main'), panel = document.querySelector('.roam-article .rv-panel');
    return !!refs && !!panel && !!(refs.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));
  await page.locator('.roam-article .rv-group-caret').first().click().catch(() => {});
  const unfolded = await waitFor('the counterpart note to unfold', () => evalIn(() => document.querySelector('.roam-article .rv-preview')?.innerText.includes('The note for this page')), 5000).catch(() => false);
  check('Unfolding a note shows it inline', unfolded);
  await shot('page-external-vault-references');
  fs.writeFileSync(path.join(small, 'Fresh CI note.md'), `Written while Roam was open, links [[${TEST_PAGE}]].\n`);
  const live = await waitFor('the new note to appear', async () => (await panelText()).includes('Fresh CI note'), 15000).then(() => true, () => false);
  check('A note added on disk shows up without a Rescan', live);
  check('The vault index is stored in SQLite in the private file system', await evalIn(async () => {
    try {
      const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('.roam-vaults');
      for await (const [, h] of d.entries()) if (h.kind === 'directory') return true;
    } catch { /* none */ }
    return false;
  }));

  // large vault: memory
  await addVault(big);
  const cold = sample('cold-scan', 90000, 60000);
  const scanned = await waitFor(`${BIG} to finish scanning`, async () => (await statusOf(BIG)) === `${NOTES} notes`, 85000).then(() => true, () => false);
  const coldM = await cold;
  check(`Large vault scans (${NOTES.toLocaleString('en-US')} notes)`, scanned, await statusOf(BIG));
  memRow('First scan, peak', coldM.peak, LIMITS.coldPeak);
  memRow('Settled 60-90 s after adding the vault', coldM.mean, LIMITS.settled);
  await shot('settings-large-vault');

  const rescan = async (label, limit, clicks = 1) => {
    const s = sample(label, 60000);
    for (let i = 0; i < clicks; i++) await clickButton('Rescan');
    await sleep(3000);
    const done = await waitFor(`${label} to finish`, async () => (await statusOf(BIG)) === `${NOTES} notes`, 55000).then(() => true, () => false);
    const m = await s;
    memRow(`${label}, peak`, m.peak, limit);
    return done;
  };
  check('Rescan with nothing changed finishes', await rescan('Rescan, nothing changed', LIMITS.rescanPeak));
  touchAll(big);
  check('Rescan with every file changed finishes', await rescan('Rescan, every file changed', LIMITS.rescanChangedPeak));
  touchAll(big);
  check('Rescan clicked 5 times finishes', await rescan('Rescan clicked 5 times, every file changed', LIMITS.rescan5Peak, 5));

  // crash guard: Roam dies in the middle of a scan
  const hasMark = () => scanMarked(BIG);
  // the 5 Rescans run as two scans one after the other: let the second one finish first
  await waitFor('every scan to finish', async () => {
    for (let i = 0; i < 8; i++) { if ((await statusOf(BIG)) !== `${NOTES} notes` || await hasMark()) return false; await sleep(250); }
    return true;
  }, 90000).catch(() => {});
  log(`before reload: ${BIG} "${await statusOf(BIG)}", mark ${await hasMark()}`);
  // Chromium writes localStorage to disk up to about 5 s after a change, so a mark set less than
  // that before a crash is lost. Double the vault so the startup scan runs well past that.
  const extra = genVault(NOTES, path.join(big, 'Extra'));
  log(`added ${extra.files} more files so the scan runs longer`);
  touchAll(big);
  await dismissDialogs();
  await page.reload();
  const marked = await waitFor('the scan mark during the startup scan', hasMark, 90000, 50).then(() => true, () => false);
  check('Startup scan marks the vault while it runs', marked);
  // A real crash (out of memory) comes well into a scan, after the mark has reached the disk.
  await sleep(8000);
  const stillScanning = await hasMark();
  log(`mark still set 8 s into the scan: ${stillScanning}`);
  check('Scan still running when Roam is killed', stillScanning);
  await killRoam('SIGKILL');
  log('Roam killed mid-scan; relaunching');
  await launchRoam();
  log(`mark after relaunch, before the extension loads: ${await waitFor('the page', async () => String(await scanMarked(BIG)), 15000).catch(() => '?')}`);
  await signIn();
  await openGraph();
  await waitFor('the extension to load after relaunch', async () => { await openSettings(); return clickLeaf('Vaults (dev)'); }, 60000);
  await waitFor('the vault list', () => evalIn(() => !!document.querySelector('.rv-settings')), 10000);
  const rows = await waitFor('both vault rows', async () => { const r = await vaultRows(); return r[BIG] && r[SMALL] && /notes?$/.test(r[SMALL].status) && r; }, 30000).catch(() => null);
  check('After a crash mid-scan the vault reads "Last scan didn\'t finish"', rows?.[BIG]?.status === "Last scan didn't finish", rows?.[BIG]?.status);
  check('…with its own Rescan button', rows?.[BIG]?.buttons.includes('Rescan'));
  check('The other vault scans normally after the crash', rows?.[SMALL]?.status === '4 notes', rows?.[SMALL]?.status);
  await shot('after-crash-last-scan-didnt-finish');
  await clickButton('Rescan', BIG);
  const recovered = await waitFor('the row Rescan to finish', async () => (await statusOf(BIG)) === `${2 * NOTES} notes`, 150000).then(() => true, () => false);
  check("The row's Rescan scans the vault and clears the mark", recovered && !(await scanMarked(BIG)), await statusOf(BIG));
  await shot('after-row-rescan');
}

let stopped = '';
try { await main(); }
catch (e) { stopped = e.message.replace(EMAIL || '\0', '***'); log('ERROR', stopped); await shot('error'); }
finally {
  const pass = writeResults(stopped);
  log(fs.readFileSync(path.join(OUT, 'RESULTS.md'), 'utf8'));
  await killRoam('SIGTERM').catch(() => {});
  server.close();
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}
