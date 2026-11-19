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
<div class="roam-article"><div class="rm-title-display-container"><h1 class="rm-title-display">Project Alpha</h1></div>
<div class="rm-block-children"><div>• Kickoff notes</div></div>
<div><div class="rm-reference-main"><div class="rm-reference-main__child-wrapper"><div class="rm-reference-container"><div class="flex-h-box"><div><strong>1 Linked References</strong></div></div></div><div class="rm-unlinked-reference-container"><div class="flex-h-box"><strong>Unlinked References</strong></div></div></div></div></div></div>`;
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end(page); }
  const f = path.join(dist, req.url);
  if (!fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', 'text/javascript'); res.end(fs.readFileSync(f));
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

// a UTF-8 locale, or the browser's private file system can't store names with accents
const browser = await chromium.launch({ env: { ...process.env, LC_ALL: 'C.UTF-8' } });
const p = await browser.newPage({ viewport: { width: 900, height: 700 } });
p.on('console', (m) => console.log('[page]', m.text()));
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(url);

const files = {
  'Projects/Project Alpha.md': '---\naliases: [Alpha]\n---\n# Project Alpha\nKickoff with [[Hiring neural]].\n',
  'Zettel/Hiring neural.md': 'Notes about hiring.\n- see [[Project Alpha]] for context\n- also #project/alpha\n',
  'Daily/2026-11-09.md': '- met about [[Project Alpha|the alpha project]]\n',
  '.obsidian/app.json': '{}',
  // names written with decomposed accents, as on a folder that came from a Mac, three folders deep
  'Re\u0301sume\u0301s/2026/Q4/Cafe\u0301 plan.md': 'line one\n- booked for [[Project Alpha]] in Lyon\n',
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
  // a cache left behind by 0.1.0: one record holding a whole vault
  await new Promise((res) => {
    const r = indexedDB.open('roam-vaults-cache', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('vaults');
    r.onsuccess = () => { const tx = r.result.transaction('vaults', 'readwrite'); tx.objectStore('vaults').put({ v: 1, entries: [] }, 'My Vault'); tx.oncomplete = () => { r.result.close(); res(); }; };
  });
  const picks = [vault, work];
  window.showDirectoryPicker = async () => picks.shift();
  console.log('seeded');
}, files);
p.on('crash', () => console.log('[crash]'));
await p.evaluate(async () => {
  window.roamAlphaAPI = {
    ui: { mainWindow: { getOpenPageOrBlockUid: async () => 'uid-alpha' } },
    pull: () => ({ ':node/title': 'Project Alpha' }),
    // the unlinked-references count query: 3 for Project Alpha, none elsewhere
    data: { async: { q: async (query, pat, title) => { window.__unlinkedAsked = [pat, title]; return title === 'Project Alpha' ? 3 : null; } } },
  };
  window.__jumps = [];
  Element.prototype.scrollIntoView = function () { window.__jumps.push(this.className || this.tagName); };
  window.__cmds = [];
  // Minimal stand-in for the React that Roam provides, enough to mount the settings component.
  window.__effects = [];
  window.React = { createElement: (t, props) => ({ t, props }), useRef: () => (window.__settingsRef = { current: null }), useEffect: (fn) => window.__effects.push(fn) };
  const settings = { panel: { create: (cfg) => { window.__settings = cfg; } }, get: (id) => (id === 'open-with' ? window.__openWith : undefined) };
  // record where the viewer's open button sends a note instead of leaving the page
  window.__opened = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (/^(obsidian|vscode):/.test(this.href)) window.__opened.push(this.href); else click.call(this); };
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
const emptyPanel = await p.evaluate(() => [...document.querySelectorAll('.rv-panel')].every((e) => !e.textContent.trim()) && !document.querySelector('.rv-counts'));
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
ok('a note whose name is not NFC on disk is read for its lines', t1.includes('R\u00e9sum\u00e9s/2026/Q4/Caf\u00e9 plan') && t1.includes('booked for [[Project Alpha]] in Lyon'));
ok('no palette commands', (await p.evaluate(() => window.__cmds.length)) === 0);
ok('nothing on the page before a vault is added', emptyPanel);
ok('settings offers Rescan once a vault exists', (await p.locator('#settings-box button', { hasText: 'Rescan' }).count()) === 1);
ok('settings tab registered with a vault list', await p.evaluate(() => window.__settings.tabTitle === 'Vaults' && window.__settings.settings[0].action.type === 'reactComponent'));
await p.waitForFunction(() => document.querySelector('#settings-box')?.textContent.includes('notes'), null, { timeout: 5000 }).catch(() => {});
ok('settings list shows the vault and its note count', /My Vault4 notes/.test(await p.locator('#settings-box').textContent()));
ok('one panel only', (await p.locator('.rv-panel').count()) === 1);
ok('panel sits below Linked References', await p.evaluate(() =>
  document.querySelector('.rm-reference-main').compareDocumentPosition(document.querySelector('.rv-panel')) & Node.DOCUMENT_POSITION_FOLLOWING));

// counts under the title: Roam's wording, linked then unlinked then vault, each jumping to its section
const counts = () => p.evaluate(() => [...document.querySelectorAll('.rv-counts strong')].map((e) => e.textContent));
ok('counts are off by default', !(await p.locator('.rv-counts').count()) && !(await p.evaluate(() => window.__unlinkedAsked)));
ok('settings has a Reference counts switch', await p.evaluate(() => window.__settings.settings.some((s) => s.id === 'reference-counts' && s.action.type === 'switch')));
await p.evaluate(() => window.__settings.settings.find((s) => s.id === 'reference-counts').action.onChange({ target: { checked: true } }));
await p.waitForFunction(() => document.querySelectorAll('.rv-counts strong').length === 3, null, { timeout: 3000 }).catch(() => {});
ok('counts line under the title reads linked, unlinked, external', JSON.stringify(await counts()) === JSON.stringify(['1 Linked References', '3 Unlinked References', '4 External Vault References']));
ok('counts line sits right below the title', await p.evaluate(() => document.querySelector('.rm-title-display-container').nextElementSibling?.classList.contains('rv-counts')));
ok('unlinked count searches the title in any case', await p.evaluate(() => JSON.stringify(window.__unlinkedAsked) === JSON.stringify(['(?i)Project Alpha', 'Project Alpha'])));
await p.evaluate(() => document.querySelectorAll('.rv-counts strong').forEach((e) => e.click()));
ok('each count jumps to its section', await p.evaluate(() => JSON.stringify(window.__jumps) === JSON.stringify(['flex-h-box', 'flex-h-box', 'rv-panel'])));

// unfold the matching note inline, and follow a link inside it
ok('header uses Roam wording, no vault prefix with one vault', t1.includes('4 External Vault References') && !t1.includes('My Vault/'));
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

// viewer opens at the top of the note, with the linked line highlighted
// (the viewer is squeezed so the note scrolls and the highlighted line starts out of view; Roam's
// own styles let the title and path rows shrink, which min-height:0 stands in for here)
await p.addStyleTag({ content: '.rv-viewer{max-height:130px}.rv-viewer>*{min-height:0}' });
await p.locator('.rv-block', { hasText: 'see [[Project Alpha]]' }).click();
await p.waitForSelector('.rv-viewer .rv-hl');
ok('viewer highlights line', (await p.locator('.rv-viewer .rv-hl').textContent()).includes('see'));
ok('viewer opens at the top of the note', await p.locator('.rv-viewer > .rv-viewer-body').evaluate((e) => e.scrollHeight > e.clientHeight && e.scrollTop === 0));
ok('viewer keeps the title and path clear of the scrolling note', await p.locator('.rv-viewer').evaluate((v) => [...v.children].slice(0, 2).every((e) => e.scrollHeight <= e.clientHeight + 1)));
await p.evaluate(() => document.querySelector('style:last-of-type')?.remove());
// the open button: Obsidian by default, the "Open notes with" link when it's set
ok('settings has an "Open notes with" text field', await p.evaluate(() => window.__settings.settings.some((x) => x.id === 'open-with' && x.name === 'Open notes with' && x.action.type === 'input')));
const openBtn = () => p.locator('.rv-viewer-head button').first();
ok('viewer button reads Open in Obsidian by default', (await openBtn().textContent()) === 'Open in Obsidian');
await openBtn().click();
ok('Open in Obsidian opens an obsidian:// link', (await p.evaluate(() => window.__opened.pop())) === 'obsidian://open?vault=My%20Vault&file=Zettel%2FHiring%20neural');
await p.keyboard.press('Escape');
await p.evaluate(() => { window.__openWith = 'vscode://file/Users/me/Notes/{vault}/{file}'; });
await p.locator('.rv-block', { hasText: 'see [[Project Alpha]]' }).click();
await p.waitForSelector('.rv-viewer .rv-hl');
ok('with "Open notes with" set, the button reads Open in editor', (await openBtn().textContent()) === 'Open in editor');
await openBtn().click();
ok('Open in editor opens the filled-in link', (await p.evaluate(() => window.__opened.pop())) === 'vscode://file/Users/me/Notes/My%20Vault/Zettel/Hiring%20neural.md');
await p.evaluate(() => { window.__openWith = ''; });
if (process.argv[2]) await p.screenshot({ path: process.argv[2].replace(/\.png$/, '-viewer.png') });
// follow a wikilink inside the viewer
await p.keyboard.press('Escape');
ok('viewer closes on Escape', (await p.locator('.rv-viewer').count()) === 0);
if (process.argv[2]) await p.screenshot({ path: process.argv[2] });

// a second vault joins the same fold, with vault names before titles; removing it leaves the first
await p.locator('#settings-box button', { hasText: 'Add vault folder' }).click();
await p.waitForFunction(() => document.querySelector('.rv-panel')?.textContent.includes('Work Notes/Alpha budget'), null, { timeout: 10000 }).catch(() => {});
const all = await p.locator('.rv-panel').textContent();
ok('one fold for both vaults, titles prefixed with vault name', (await p.locator('.rv-sec').count()) === 1 && all.includes('6 External Vault References') && all.includes('My Vault/Projects/Project Alpha') && all.includes('Work Notes/Alpha budget') && all.includes('Budget for'));
if (process.argv[2]) await p.screenshot({ path: process.argv[2].replace(/\.png$/, '-two-vaults.png'), fullPage: true });
// the parsed-note cache: one record per note, keyed by [vault id, path]
const cacheKeys = () => p.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open('roam-vaults-cache');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => {
    const db = r.result, stores = [...db.objectStoreNames];
    const q = db.transaction('notes').objectStore('notes').getAllKeys();
    q.onsuccess = () => { db.close(); res({ stores, keys: q.result.map((k) => k.join(' | ')) }); };
  };
}));
await p.waitForTimeout(2500); // let the worker's debounced cache save land
const cached = await cacheKeys();
ok('each note is cached under its vault and path', cached.keys.includes('Work Notes | Alpha budget.md') && cached.keys.includes('My Vault | Projects/Project Alpha.md') && cached.keys.includes('My Vault | Fresh idea.md') && cached.keys.includes('My Vault | R\u00e9sum\u00e9s/2026/Q4/Caf\u00e9 plan.md') && cached.keys.length === 6);
ok('the single-record cache of 0.1.0 is gone', cached.stores.join() === 'notes');
ok('settings list shows both vaults', (await p.locator('#settings-box .rv-settings-row').count()) === 2);
if (process.argv[2]) await p.locator('#settings-box').screenshot({ path: process.argv[2].replace(/\.png$/, '-settings.png') });
await p.locator('#settings-box .rv-settings-row', { hasText: 'Work Notes' }).locator('button', { hasText: 'Remove' }).click();

ok('remove deletes only that vault\'s cache', await p.waitForFunction(() => true).then(async () => { await p.waitForTimeout(300); const { keys } = await cacheKeys(); return !keys.some((k) => k.startsWith('Work Notes | ')) && keys.filter((k) => k.startsWith('My Vault | ')).length === 5; }));
ok('settings list updates after remove', await p.waitForFunction(() => document.querySelectorAll('#settings-box .rv-settings-row').length === 1, null, { timeout: 3000 }).then(() => true, () => false));
ok('remove drops only that vault', await p.waitForFunction(() => { const t = document.querySelector('.rv-panel').textContent; return !t.includes('Alpha budget') && t.includes('5 External Vault References') && !t.includes('My Vault/'); }, null, { timeout: 3000 }).then(() => true, () => false));
ok('the vault count follows the panel', await p.waitForFunction(() => document.querySelector('.rv-counts')?.textContent.includes('5 External Vault References'), null, { timeout: 3000 }).then(() => true, () => false));

// a page no vault note mentions shows nothing, like Roam's own empty reference sections
await p.evaluate(() => { window.roamAlphaAPI.pull = () => ({ ':node/title': 'Nothing Mentions This' }); window.dispatchEvent(new HashChangeEvent('hashchange')); });
ok('page with no matches shows nothing', await p.waitForFunction(() => { const e = document.querySelector('.rv-panel'); return e && e.dataset.title === 'Nothing Mentions This' && !e.textContent.trim() && getComputedStyle(e).display === 'none'; }, null, { timeout: 3000 }).then(() => true, () => false));
ok('counts of zero are left out', await p.waitForFunction(() => document.querySelector('.rv-counts')?.textContent === '1 Linked References', null, { timeout: 3000 }).then(() => true, () => false));
await p.evaluate(() => window.__settings.settings.find((s) => s.id === 'reference-counts').action.onChange({ target: { checked: false } }));
ok('turning the switch off removes the counts line', await p.waitForFunction(() => !document.querySelector('.rv-counts'), null, { timeout: 3000 }).then(() => true, () => false));

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
// Roam lays a setting out as a row: name and description on the left, the control on the right. Both
// columns shrink in proportion to their natural widths, so in a 1024 px window the control gets about
// 225 px of a 670 px row, and in a 640 px window under 100 px of a 285 px row. Every button must stay
// inside the control column and keep its whole label. The stub gives buttons Blueprint's small sizes.
const fits = (q, rowWidth) => q.evaluate((rowWidth) => {
  const box = document.querySelector('#settings-box');
  if (!document.querySelector('#roam-row')) {
    const s = document.createElement('style');
    s.textContent = '.bp3-button{display:inline-flex;align-items:center;text-align:left;min-width:24px;min-height:24px;padding:0 7px;font:14px sans-serif;border:0}';
    document.head.append(s);
    const row = document.createElement('div'); row.id = 'roam-row'; row.style.cssText = 'display:flex;gap:27px;font:14px sans-serif';
    const left = document.createElement('div'); left.style.cssText = 'flex:0 1 575px;min-width:0';
    const right = document.createElement('div'); right.style.cssText = 'flex:0 1 auto;min-width:0';
    row.append(left, right); document.body.append(row); right.append(box);
  }
  document.querySelector('#roam-row').style.width = `${rowWidth}px`;
  const edge = box.parentElement.getBoundingClientRect();
  const buttons = [...box.querySelectorAll('button')];
  const inside = buttons.length > 0 && buttons.every((b) => {
    const r = b.getBoundingClientRect();
    return b.scrollWidth <= b.clientWidth + 1 && r.left >= edge.left - 0.5 && r.right <= edge.right + 0.5;
  });
  // is the first row's button group beside the vault name (not below it)?
  const name = box.querySelector('.rv-settings-name').getBoundingClientRect();
  const group = box.querySelector('.rv-settings-btns').getBoundingClientRect();
  return { inside, beside: group.left >= name.right - 0.5 && group.top < name.bottom, column: Math.round(edge.width) };
}, rowWidth);
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
  ok('Reconnect and Remove stay inside the settings column', (await fits(q, 670)).inside && (await fits(q, 450)).inside && (await fits(q, 285)).inside);
  await q.context().close();
}
{ // a scan that never finished (Roam ran out of memory) is not started again on load
  const q = await fresh();
  await q.evaluate(async () => {
    const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('My Vault');
    // A handle read back from IndexedDB crashes headless Chromium, so the saved list is handed over directly.
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) { return key === 'vaults' ? { result: [{ id: 'My Vault', handle: vault }] } : get.call(this, key); };
    localStorage.setItem('roam-vaults:scanning:My Vault', '1');
    window.__ext.onload({ extensionAPI: window.__api });
  });
  await mountSettings(q);
  ok('a vault whose last scan never finished waits instead of scanning on load', await rowHas(q, "Last scan didn't finish"));
  // the Rescan for all vaults leaves it alone too
  await q.evaluate(() => [...document.querySelectorAll('.rv-settings-actions button')].find((b) => b.textContent === 'Rescan').click());
  await q.waitForTimeout(800);
  const t = await row(q);
  ok('it is not scanned, and nothing shows on the page', t.includes("Last scan didn't finish") && !/\d+ notes?/.test(t) && !(await q.evaluate(() => document.querySelector('.rv-panel')?.textContent.trim())));
  ok('its row has Rescan and Remove inside the settings column', (await q.locator('.rv-settings-btns button').allTextContents()).join() === 'Rescan,Remove' && (await fits(q, 670)).inside && (await fits(q, 285)).inside);
  await q.evaluate(() => document.querySelector('.rv-settings-btns button').click());
  ok('its Rescan scans it and clears the mark', await rowHas(q, '1 note') && await q.evaluate(() => localStorage.getItem('roam-vaults:scanning:My Vault') === null));
  await q.context().close();
}
{ // a crash can lose localStorage, so the mark is also kept in IndexedDB, written to disk at once
  const putMark = (q, token) => q.evaluate((token) => new Promise((res, rej) => {
    const r = indexedDB.open('roam-vaults-marks', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('scanning');
    r.onsuccess = () => { const tx = r.result.transaction('scanning', 'readwrite'); tx.objectStore('scanning').put(token, 'My Vault'); tx.oncomplete = () => { r.result.close(); res(); }; tx.onerror = () => rej(tx.error); };
  }), token);
  const onloadSaved = (q) => q.evaluate(async () => {
    const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('My Vault');
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) { return key === 'vaults' ? { result: [{ id: 'My Vault', handle: vault }] } : get.call(this, key); };
    window.__ext.onload({ extensionAPI: window.__api });
  });
  let q = await fresh();
  await putMark(q, 't1');
  await onloadSaved(q);
  await mountSettings(q);
  ok('a mark only in IndexedDB (localStorage lost in a crash) still stops the scan on load', await rowHas(q, "Last scan didn't finish"));
  await q.context().close();
  q = await fresh();
  await putMark(q, 't2');
  await q.evaluate(() => localStorage.setItem('roam-vaults:closed:My Vault', 't2'));
  await onloadSaved(q);
  await mountSettings(q);
  ok('a mark whose scan was closed with Roam (not a crash) scans as usual', await rowHas(q, '1 note'));
  await q.context().close();
}
{ // a scan writes its mark to IndexedDB with strict durability and deletes it when done
  const q = await fresh();
  await q.evaluate(() => {
    window.__idb = [];
    const tx = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (names, mode, opts) { if (String(names) === 'scanning' && mode === 'readwrite') window.__idb.push(opts?.durability); return tx.call(this, names, mode, opts); };
    return window.__ext.onload({ extensionAPI: window.__api });
  });
  await mountSettings(q);
  await press(q, 'Add vault folder');
  await rowHas(q, '1 note');
  await q.waitForTimeout(500);
  const left = await q.evaluate(() => new Promise((res) => { const r = indexedDB.open('roam-vaults-marks', 1); r.onsuccess = () => { const g = r.result.transaction('scanning').objectStore('scanning').count(); g.onsuccess = () => { r.result.close(); res(g.result); }; }; }));
  ok('the IndexedDB mark is written strictly while scanning and gone after', await q.evaluate(() => window.__idb.length >= 2 && window.__idb.every((d) => d === 'strict')) && left === 0);
  await q.context().close();
}
{ // the mark is set while a scan runs and cleared when it ends
  const q = await fresh();
  await q.evaluate(() => {
    window.__marks = [];
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k.startsWith('roam-vaults:')) window.__marks.push(k); return set.call(this, k, v); };
    return window.__ext.onload({ extensionAPI: window.__api });
  });
  await mountSettings(q);
  await press(q, 'Add vault folder');
  await rowHas(q, '1 note');
  await q.waitForTimeout(300);
  ok('a scan marks the vault while it runs and clears the mark when done', await q.evaluate(() =>
    window.__marks.includes('roam-vaults:scanning:My Vault') && localStorage.getItem('roam-vaults:scanning:My Vault') === null));
  await q.context().close();
}
{ // a scan that fails says so instead of staying on "Indexing"
  const q = await fresh();
  await q.evaluate(() => window.__ext.onload({ extensionAPI: window.__api }));
  await mountSettings(q);
  await press(q, 'Add vault folder');
  await rowHas(q, '1 note');
  const wide = await fits(q, 670), mid = await fits(q, 450), narrow = await fits(q, 285);
  if (process.env.RV_DEBUG) console.log('control column widths', wide.column, mid.column, narrow.column);
  ok('in a 1024 px window Remove sits beside the vault name, inside the column', wide.inside && wide.beside);
  ok('buttons stay inside the settings column in narrow windows', mid.inside && narrow.inside);
  await q.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('My Vault', { recursive: true }));
  await q.waitForTimeout(600);
  await press(q, 'Rescan');
  ok('a failed scan shows as "Couldn\'t read", not "Indexing"', await rowHas(q, "Couldn't read"));
  ok('buttons stay inside the settings column beside a long status', (await fits(q, 670)).inside && (await fits(q, 450)).inside && (await fits(q, 285)).inside);
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

{ // a page with hundreds of notes to list draws the first of them, and the rest as it is scrolled
  const q = await fresh();
  await q.setViewportSize({ width: 900, height: 700 });
  const TAGGED = 400;
  await q.evaluate(async (TAGGED) => {
    // as in Roam, the page scrolls inside a box of its own, not the window
    const wrap = document.createElement('div'); wrap.id = 'scroller'; wrap.style.cssText = 'height:100vh;overflow:auto';
    document.body.prepend(wrap); wrap.append(document.querySelector('.roam-article'));
    const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('My Vault');
    for (let i = 0; i < TAGGED; i++) {
      const w = await (await vault.getFileHandle(`Tagged ${String(i).padStart(3, '0')}.md`, { create: true })).createWritable();
      await w.write('about #project-alpha\n'); await w.close();
    }
    await window.__ext.onload({ extensionAPI: window.__api });
  }, TAGGED);
  await mountSettings(q);
  await press(q, 'Add vault folder');
  await q.waitForFunction(() => document.querySelector('.rv-panel')?.textContent.includes('Tagged 000'), null, { timeout: 15000 });
  const groups = () => q.locator('.rv-group').count();
  const first = await groups();
  ok('a long list draws only its first notes', first === 60 && (await q.locator('.rv-sec-head').textContent()).includes(`${TAGGED + 1} External Vault References`));
  // scrolling to the end of what is drawn brings more, until every note is there
  let n = first;
  for (let i = 0; i < 40 && n < TAGGED + 1; i++) {
    await q.evaluate(() => { const s = document.querySelector('#scroller'); s.scrollTop = s.scrollHeight; });
    await q.waitForFunction((n) => document.querySelectorAll('.rv-group').length > n, n, { timeout: 3000 }).catch(() => {});
    const now = await groups();
    if (i === 0) ok('scrolling near the end of the list draws more', now > first && now < TAGGED + 1);
    if (now === n) break;
    n = now;
  }
  ok('scrolling on draws every note, each once, in order', n === TAGGED + 1 && await q.evaluate((TAGGED) => {
    const names = [...document.querySelectorAll('.rv-note')].map((e) => e.textContent);
    return new Set(names).size === names.length && names[0] === 'Other' && names[1] === 'Tagged 000' && names[TAGGED] === `Tagged ${TAGGED - 1}` && !document.querySelector('.rv-more');
  }, TAGGED));
  // a change in the vault draws the list again: it stays as long as it had got
  await q.evaluate(async () => {
    const vault = await (await navigator.storage.getDirectory()).getDirectoryHandle('My Vault');
    const w = await (await vault.getFileHandle('Tagged late.md', { create: true })).createWritable();
    await w.write('also #project-alpha\n'); await w.close();
  });
  await q.waitForFunction(() => document.querySelector('.rv-sec-head')?.textContent.includes('402 External'), null, { timeout: 5000 }).catch(() => {});
  ok('a list drawn again after a change keeps its length', (await groups()) >= TAGGED + 1);
  await q.context().close();
}

for (const [n, pass] of checks) console.log(pass ? 'PASS' : 'FAIL', n);
await browser.close(); server.close();
process.exit(checks.every(([, pass]) => pass) ? 0 : 1);
