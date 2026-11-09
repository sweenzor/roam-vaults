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
  const ext = (await import('/extension.js')).default;
  console.log('imported');
  window.__ext = ext;
  await ext.onload({ extensionAPI: { ui: { commandPalette: { addCommand: (c) => window.__cmds.push(c), removeCommand() {} } } } });
  console.log('loaded');
  await window.__cmds.find((c) => c.label === 'External Vault References: Add vault folder').callback();
});

const text = async () => p.locator('.rv-panel').textContent();
await p.waitForFunction(() => document.querySelector('.rv-panel')?.textContent.includes('see Project Alpha'), null, { timeout: 10000 }).catch(async (e) => { console.log('panel now:', await p.evaluate(() => document.querySelector('.rv-panel')?.outerHTML?.slice(0, 600) ?? document.body.innerHTML.slice(0, 800))); throw e; });
console.log('--- panel ---\n' + await text());
const checks = [];
const ok = (name, cond) => { checks.push([name, !!cond]); };
const t1 = await text();
ok('counterpart shown', t1.includes('this page · same name'));
ok('backlink snippet shown', t1.includes('see Project Alpha for context'));
ok('daily backlink shown', t1.includes('2026-11-09'));
ok('commands registered', (await p.evaluate(() => window.__cmds.length)) === 3);
ok('one panel only', (await p.locator('.rv-panel').count()) === 1);
ok('panel sits below Linked References', await p.evaluate(() =>
  document.querySelector('.rm-reference-main').compareDocumentPosition(document.querySelector('.rv-panel')) & Node.DOCUMENT_POSITION_FOLLOWING));

// unfold the matching note inline, and follow a link inside it
ok('header uses Roam wording', t1.includes('3 External Vault References') && t1.includes('My Vault'));
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
await p.locator('.rv-block', { hasText: 'see Project Alpha' }).click();
await p.waitForSelector('.rv-viewer .rv-hl');
ok('viewer highlights line', (await p.locator('.rv-viewer .rv-hl').textContent()).includes('see'));
if (process.argv[2]) await p.screenshot({ path: process.argv[2].replace(/\.png$/, '-viewer.png') });
// follow a wikilink inside the viewer
await p.keyboard.press('Escape');
ok('viewer closes on Escape', (await p.locator('.rv-viewer').count()) === 0);
if (process.argv[2]) await p.screenshot({ path: process.argv[2] });

// a second vault gets its own section; removing it leaves the first
await p.evaluate(() => window.__cmds.find((c) => c.label === 'External Vault References: Add vault folder').callback());
await p.waitForFunction(() => document.querySelectorAll('.rv-sec').length === 2 && document.querySelectorAll('.rv-sec')[1].textContent.includes('Alpha budget'), null, { timeout: 10000 }).catch(() => {});
const secs = await p.locator('.rv-sec').allTextContents();
ok('second vault gets its own section', secs.length === 2 && secs[1].includes('Work Notes') && secs[1].includes('Budget for'));
if (process.argv[2]) await p.screenshot({ path: process.argv[2].replace(/\.png$/, '-two-vaults.png'), fullPage: true });
await p.locator('.rv-sec').nth(1).locator('.rv-sec-head').hover();
await p.locator('.rv-sec').nth(1).locator('.rv-tool', { hasText: 'Remove' }).click();
ok('remove drops only that vault', await p.waitForFunction(() => { const s = document.querySelectorAll('.rv-sec'); return s.length === 1 && s[0].textContent.includes('My Vault'); }, null, { timeout: 3000 }).then(() => true, () => false));

await p.evaluate(() => window.__ext.onunload());
ok('unload removes everything', (await p.locator('[data-roam-vaults]').count()) === 0);

for (const [n, pass] of checks) console.log(pass ? 'PASS' : 'FAIL', n);
await browser.close(); server.close();
process.exit(checks.every(([, pass]) => pass) ? 0 : 1);
