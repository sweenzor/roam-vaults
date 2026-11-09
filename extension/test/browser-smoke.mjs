// Headless-Chromium smoke test of dist/extension.js against a fake Roam page and an OPFS vault.
// node test/browser-smoke.mjs [screenshot.png]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const dist = path.resolve(import.meta.dirname, '../dist');
const page = `<!doctype html><meta charset=utf-8><title>fake roam</title>
<style>body{font:14px system-ui;margin:0}.roam-article{max-width:720px;margin:24px auto}.rm-caret{display:inline-block;width:16px;text-align:center;color:#8a9ba8}.rm-caret-open::before{content:'▾'}.rm-caret-closed::before{content:'▸'}.flex-h-box{display:flex}</style><!-- stand-ins for Roam's caret styles -->
<div class="roam-article"><h1 class="rm-title-display">Project Alpha</h1>
<div class="rm-block-children"><div>• Kickoff notes</div></div>
<div><div class="rm-reference-main">1 Linked Reference</div></div></div>`;
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end(page); }
  const f = path.join(dist, req.url);
  if (!fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', 'text/javascript'); res.end(fs.readFileSync(f));
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 900, height: 700 } });
p.on('console', (m) => console.log('[page]', m.text()));
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(url);

const files = {
  'Projects/Project Alpha.md': '---\naliases: [Alpha]\n---\n# Project Alpha\nKickoff with [[Hiring neural]].\n',
  'Zettel/Hiring neural.md': 'Notes about hiring.\n- see [[Project Alpha]] for context\n- also #project/alpha\n',
  'Daily/2026-11-09.md': '- met about [[Project Alpha|the alpha project]]\n',
  '.obsidian/app.json': '{}',
};
await p.evaluate(async (files) => {
  const root = await navigator.storage.getDirectory();
  const vault = await root.getDirectoryHandle('My Vault', { create: true });
  for (const [rel, text] of Object.entries(files)) {
    const parts = rel.split('/'); let d = vault;
    for (const s of parts.slice(0, -1)) d = await d.getDirectoryHandle(s, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(text); await w.close();
  }
  // Headless Chromium crashes when an OPFS handle is read back from IndexedDB, so the vault is
  // connected through the picker path (stubbed) instead of a pre-saved handle.
  const work = await root.getDirectoryHandle('Work Notes', { create: true });
  const w2 = await (await work.getFileHandle('Alpha budget.md', { create: true })).createWritable();
  await w2.write('Budget for [[Project Alpha]] is approved.\n'); await w2.close();
  const picks = [vault, work];
  window.showDirectoryPicker = async () => picks.shift();
  console.log('seeded');
}, files);
p.on('crash', () => console.log('[crash]'));
await p.evaluate(async () => {
  window.roamAlphaAPI = {
    ui: { mainWindow: { getOpenPageOrBlockUid: async () => 'uid-alpha' } },
    pull: () => ({ ':node/title': 'Project Alpha' }),
  };
  window.__cmds = [];
  // Minimal stand-in for the React that Roam provides, enough to mount the settings component.
  window.__effects = [];
  window.React = { createElement: (t, props) => ({ t, props }), useRef: () => (window.__settingsRef = { current: null }), useEffect: (fn) => window.__effects.push(fn) };
  const settings = { panel: { create: (cfg) => { window.__settings = cfg; } } };
  const ext = (await import('/extension.js')).default;
  console.log('imported');
  window.__ext = ext;
  await ext.onload({ extensionAPI: { settings, ui: { commandPalette: { addCommand: (c) => window.__cmds.push(c), removeCommand(c) { window.__cmds = window.__cmds.filter((x) => x.label !== c.label); } } } } });
  // mount the settings component into a visible box, as Roam's settings page would
  const box = document.createElement('div'); box.id = 'settings-box'; document.body.append(box);
  const comp = window.__settings.settings[0].action.component; comp();
  window.__settingsRef.current = box; window.__effects.forEach((fn) => fn());
  console.log('loaded');
});
// with no vaults the page shows nothing, and there are no palette commands (so no hotkeys)
await p.waitForTimeout(300);
const emptyPanel = await p.evaluate(() => [...document.querySelectorAll('.rv-panel')].every((e) => !e.textContent.trim()));
await p.evaluate(() => [...document.querySelectorAll('#settings-box button')].find((b) => b.textContent === 'Add vault folder').click());

const text = async () => p.locator('.rv-panel').textContent();
await p.waitForFunction(() => document.querySelector('.rv-panel')?.textContent.includes('see [[Project Alpha]]'), null, { timeout: 10000 }).catch(async (e) => { console.log('panel now:', await p.evaluate(() => document.querySelector('.rv-panel')?.outerHTML?.slice(0, 600) ?? document.body.innerHTML.slice(0, 800))); throw e; });
console.log('--- panel ---\n' + await text());
const checks = [];
const ok = (name, cond) => { checks.push([name, !!cond]); };
const t1 = await text();
ok('counterpart shown first, with its vault path as a namespaced title', (await p.locator('.rv-note').first().textContent()) === 'Projects/Project Alpha');
ok('lines use Roam reference-item styling', (await p.locator('.rv-block.rm-reference-item').count()) > 0);
ok('no Open in Obsidian link on the page itself', !(await p.locator('.rv-panel').textContent()).includes('Open in Obsidian'));
ok('backlink snippet shown', t1.includes('see [[Project Alpha]] for context'));
ok('wikilinks keep faint brackets like Roam', (await p.locator('.rv-block .rv-br').count()) > 0 && (await p.locator('.rv-block', { hasText: 'the alpha project' }).locator('.rv-br').count()) === 0);
ok('daily backlink shown', t1.includes('2026-11-09'));
ok('no palette commands', (await p.evaluate(() => window.__cmds.length)) === 0);
ok('nothing on the page before a vault is added', emptyPanel);
ok('settings offers Rescan once a vault exists', (await p.locator('#settings-box button', { hasText: 'Rescan' }).count()) === 1);
ok('settings tab registered with a vault list', await p.evaluate(() => window.__settings.tabTitle === 'Vaults' && window.__settings.settings[0].action.type === 'reactComponent'));
await p.waitForFunction(() => document.querySelector('#settings-box')?.textContent.includes('notes'), null, { timeout: 5000 }).catch(() => {});
ok('settings list shows the vault and its note count', /My Vault3 notes/.test(await p.locator('#settings-box').textContent()));
ok('one panel only', (await p.locator('.rv-panel').count()) === 1);
ok('panel sits below Linked References', await p.evaluate(() =>
  document.querySelector('.rm-reference-main').compareDocumentPosition(document.querySelector('.rv-panel')) & Node.DOCUMENT_POSITION_FOLLOWING));

// unfold the matching note inline, and follow a link inside it
ok('header uses Roam wording, no vault prefix with one vault', t1.includes('3 External Vault References') && !t1.includes('My Vault/'));
ok('counterpart folded by default', await p.locator('.rv-group').first().locator('.rv-content').evaluate((e) => e.hidden));
await p.locator('.rv-group-caret').first().click();
await p.waitForFunction(() => document.querySelector('.rv-preview')?.textContent.includes('Kickoff with'), null, { timeout: 5000 });
ok('unfold shows the note inline', await p.locator('.rv-preview').evaluate((e) => !e.hidden && !!e.querySelector('h2')));
await p.locator('.rv-preview .rv-wl', { hasText: 'Hiring neural' }).click();
await p.waitForSelector('.rv-viewer');
ok('link in unfolded note opens viewer', (await p.locator('.rv-viewer h3').textContent()) === 'Hiring neural');
await p.keyboard.press('Escape');

// live update: add a note on disk, expect it in the panel without a rescan
await p.evaluate(async () => {
  const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('My Vault');
  const w = await (await vault.getFileHandle('Fresh idea.md', { create: true })).createWritable();
  await w.write('This builds on [[Project Alpha]].\n'); await w.close();
});
const live = await p.waitForFunction(() => document.querySelector('.rv-panel')?.textContent.includes('Fresh idea'), null, { timeout: 5000 }).then(() => true, () => false);
ok('live update via FileSystemObserver', live);
ok('unfolded note stays open after live update', await p.locator('.rv-preview').evaluate((e) => !e.hidden && e.textContent.includes('Kickoff with')));

// viewer opens at the linked line
await p.locator('.rv-block', { hasText: 'see [[Project Alpha]]' }).click();
await p.waitForSelector('.rv-viewer .rv-hl');
ok('viewer highlights line', (await p.locator('.rv-viewer .rv-hl').textContent()).includes('see'));
if (process.argv[2]) await p.screenshot({ path: process.argv[2].replace(/\.png$/, '-viewer.png') });
// follow a wikilink inside the viewer
await p.keyboard.press('Escape');
ok('viewer closes on Escape', (await p.locator('.rv-viewer').count()) === 0);
if (process.argv[2]) await p.screenshot({ path: process.argv[2] });

// a second vault joins the same fold, with vault names before titles; removing it leaves the first
await p.locator('#settings-box button', { hasText: 'Add vault folder' }).click();
await p.waitForFunction(() => document.querySelector('.rv-panel')?.textContent.includes('Work Notes/Alpha budget'), null, { timeout: 10000 }).catch(() => {});
const all = await p.locator('.rv-panel').textContent();
ok('one fold for both vaults, titles prefixed with vault name', (await p.locator('.rv-sec').count()) === 1 && all.includes('5 External Vault References') && all.includes('My Vault/Projects/Project Alpha') && all.includes('Work Notes/Alpha budget') && all.includes('Budget for'));
if (process.argv[2]) await p.screenshot({ path: process.argv[2].replace(/\.png$/, '-two-vaults.png'), fullPage: true });
const cacheKeys = () => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('roam-vaults-cache', 1); r.onsuccess = () => { const q = r.result.transaction('vaults').objectStore('vaults').getAllKeys(); q.onsuccess = () => { r.result.close(); res(q.result); }; }; }));
await p.waitForTimeout(2500); // let the worker's debounced cache save land
ok('second vault cached', (await cacheKeys()).includes('Work Notes'));
ok('settings list shows both vaults', (await p.locator('#settings-box .rv-settings-row').count()) === 2);
if (process.argv[2]) await p.locator('#settings-box').screenshot({ path: process.argv[2].replace(/\.png$/, '-settings.png') });
await p.locator('#settings-box .rv-settings-row', { hasText: 'Work Notes' }).locator('button', { hasText: 'Remove' }).click();

ok('remove deletes only that vault\'s cache', await p.waitForFunction(() => true).then(async () => { await p.waitForTimeout(300); const k = await cacheKeys(); return !k.includes('Work Notes') && k.includes('My Vault'); }));
ok('settings list updates after remove', await p.waitForFunction(() => document.querySelectorAll('#settings-box .rv-settings-row').length === 1, null, { timeout: 3000 }).then(() => true, () => false));
ok('remove drops only that vault', await p.waitForFunction(() => { const t = document.querySelector('.rv-panel').textContent; return !t.includes('Alpha budget') && t.includes('4 External Vault References') && !t.includes('My Vault/'); }, null, { timeout: 3000 }).then(() => true, () => false));

// a page no vault note mentions shows nothing, like Roam's own empty reference sections
await p.evaluate(() => { window.roamAlphaAPI.pull = () => ({ ':node/title': 'Nothing Mentions This' }); window.dispatchEvent(new HashChangeEvent('hashchange')); });
ok('page with no matches shows nothing', await p.waitForFunction(() => { const e = document.querySelector('.rv-panel'); return e && e.dataset.title === 'Nothing Mentions This' && !e.textContent.trim() && getComputedStyle(e).display === 'none'; }, null, { timeout: 3000 }).then(() => true, () => false));

await p.evaluate(() => window.__ext.onunload());
ok('unload removes everything', (await p.locator('[data-roam-vaults]').count()) === 0);

// ---------- failure paths, each in a fresh browser context (so nothing is saved from above) ----------
async function fresh() {
  const q = await (await browser.newContext()).newPage();
  q.on('console', (m) => console.log('[page]', m.text()));
  await q.goto(url);
  await q.evaluate(async () => {
    const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('My Vault', { create: true });
    const w = await (await vault.getFileHandle('Other.md', { create: true })).createWritable();
    await w.write('see [[Project Alpha]]\n'); await w.close();
    window.showDirectoryPicker = async () => vault;
    window.__lookups = 0;
    window.roamAlphaAPI = { ui: { mainWindow: { getOpenPageOrBlockUid: async () => { window.__lookups++; return 'uid-alpha'; } } }, pull: () => ({ ':node/title': 'Project Alpha' }) };
    window.__effects = [];
    window.React = { createElement: (t, props) => ({ t, props }), useRef: () => (window.__settingsRef = { current: null }), useEffect: (fn) => window.__effects.push(fn) };
    window.__api = { settings: { panel: { create: (cfg) => { window.__settings = cfg; } } } };
    window.__ext = (await import('/extension.js')).default;
  });
  return q;
}
const mountSettings = (q) => q.evaluate(() => {
  const box = document.createElement('div'); box.id = 'settings-box'; document.body.append(box);
  window.__settings.settings[0].action.component(); window.__settingsRef.current = box; window.__effects.forEach((fn) => fn());
});
const press = (q, label) => q.evaluate((label) => [...document.querySelectorAll('#settings-box button')].find((b) => b.textContent === label).click(), label);
const row = (q) => q.locator('#settings-box .rv-settings-row').textContent();
const rowHas = (q, text) => q.waitForFunction((text) => document.querySelector('#settings-box .rv-settings-row')?.textContent.includes(text), text, { timeout: 5000 }).then(() => true, () => false);

{ // Rescan must leave a vault that still needs permission alone
  const q = await fresh();
  await q.evaluate(() => { FileSystemDirectoryHandle.prototype.queryPermission = () => Promise.resolve('prompt'); });
  await q.evaluate(() => window.__ext.onload({ extensionAPI: window.__api }));
  await mountSettings(q);
  await press(q, 'Add vault folder');
  await rowHas(q, 'Needs permission again');
  await press(q, 'Rescan');
  await q.waitForTimeout(800);
  const t = await row(q);
  ok('rescan leaves a vault that needs permission alone', t.includes('Needs permission again') && t.includes('Reconnect') && (await q.locator('.rv-toast').count()) === 0);
  await q.context().close();
}
{ // a scan that fails says so instead of staying on "Indexing"
  const q = await fresh();
  await q.evaluate(() => window.__ext.onload({ extensionAPI: window.__api }));
  await mountSettings(q);
  await press(q, 'Add vault folder');
  await rowHas(q, '1 note');
  await q.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('My Vault', { recursive: true }));
  await q.waitForTimeout(600);
  await press(q, 'Rescan');
  ok('a failed scan shows as "Couldn\'t read", not "Indexing"', await rowHas(q, "Couldn't read"));
  ok('a failed scan clears the page section', await q.waitForFunction(() => !document.querySelector('.rv-panel')?.textContent.trim(), null, { timeout: 3000 }).then(() => true, () => false));
  // the folder comes back: Rescan recovers without a reload
  await q.evaluate(async () => {
    const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('My Vault', { create: true });
    const w = await (await vault.getFileHandle('Back.md', { create: true })).createWritable();
    await w.write('again [[Project Alpha]]\n'); await w.close();
  });
  await press(q, 'Rescan');
  ok('rescan recovers once the folder is back', await q.waitForFunction(() => document.querySelector('.rv-panel')?.textContent.includes('again'), null, { timeout: 5000 }).then(() => true, () => false));
  await q.context().close();
}
{ // unloading while onload is still reading the saved vaults leaves nothing behind
  const q = await fresh();
  const left = await q.evaluate(async () => {
    const loading = window.__ext.onload({ extensionAPI: window.__api });
    window.__ext.onunload();
    await loading;
    await new Promise((r) => setTimeout(r, 300));
    return document.querySelectorAll('[data-roam-vaults]').length;
  });
  ok('unload during load leaves nothing behind', left === 0);
  await q.context().close();
}
{ // with no vaults, page changes cost no Roam lookups and add no panel
  const q = await fresh();
  const r = await q.evaluate(async () => {
    await window.__ext.onload({ extensionAPI: window.__api });
    const el = document.createElement('div'); document.body.append(el);
    for (let i = 0; i < 20; i++) { el.append(document.createElement('span')); await new Promise((r) => setTimeout(r, 25)); }
    return { lookups: window.__lookups, panels: document.querySelectorAll('.rv-panel').length };
  });
  ok('no page work while no vault is connected', r.lookups === 0 && r.panels === 0);
  await q.context().close();
}

for (const [n, pass] of checks) console.log(pass ? 'PASS' : 'FAIL', n);
await browser.close(); server.close();
process.exit(checks.every(([, pass]) => pass) ? 0 : 1);
