// Quick look at the built extension in Roam's public help graph, in a headless browser. No sign-in.
// The help graph is read-only and has several hundred uploaded files, so it shows the list, sorting,
// search and sizes. Deleting is covered by the real-Roam run (test/real-roam.mjs), on a test graph.
//
//   npm run build && node test/help-graph.mjs [out-dir]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();

const OUT = path.resolve(process.argv[2] || 'real-roam-out/help');
fs.mkdirSync(OUT, { recursive: true });
const code = fs.readFileSync(new URL('../extension.js', import.meta.url), 'utf8');
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok }); console.log(ok ? 'PASS' : 'FAIL', name, detail); };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
page.on('console', (m) => { if (m.text().includes('roam-file-manager')) console.log('[page]', m.text().slice(0, 300)); });
await page.goto('https://roamresearch.com/#/app/help', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.roamAlphaAPI && document.querySelector('.rm-title-display, .roam-log-container'), null, { timeout: 90000 });
await page.waitForTimeout(3000);
await page.addStyleTag({ content: '.bp3-toast-container{display:none!important}' });
await page.evaluate(async (code) => {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  window.__ext = (await import(url)).default;
  window.__ext.onload({ extensionAPI: {} });
  await window.roamAlphaAPI.ui.leftSidebar.open();
}, code);
await page.waitForSelector('.rm-left-sidebar__all-files');
check('All Files row sits under All Pages', await page.evaluate(() => document.querySelector('.rm-left-sidebar__all-pages').nextElementSibling?.classList.contains('rm-left-sidebar__all-files')));
await page.click('.rm-left-sidebar__all-files');
await page.waitForSelector('.rfm-view .rm-pages-row:not(.rm-pages-row-header)', { timeout: 30000 });
const t0 = Date.now();
await page.waitForFunction(() => [...document.querySelectorAll('.rfm-view .rfm-col-size')].slice(1, 12).every((e) => e.textContent), null, { timeout: 60000 });
console.log('sizes on the first screen after', Date.now() - t0, 'ms');
const info = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.rfm-view .rm-pages-row:not(.rm-pages-row-header)')];
  const sc = document.querySelector('.rfm-scroller');
  return { dom: rows.length, total: Math.round(sc.firstElementChild.offsetHeight / 39), first: rows.slice(0, 3).map((r) => r.innerText.replace(/\s+/g, ' ').trim()) };
});
let i = await info();
check('lists the graph\'s files', i.total > 100, `${i.total} files`);
check('draws only the rows in view', i.dom < 60, `${i.dom} rows in the DOM`);
check('sorted by date added, newest first', await page.evaluate(() => document.querySelector('[data-col="added"] .sort-button.desc').classList.contains('focused')));
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(OUT, '1-all-files.png') });

// scroll far: rows are swapped, not added
const fps = await page.evaluate(async () => {
  const sc = document.querySelector('.rfm-scroller'); let frames = 0; const t0 = performance.now();
  await new Promise((res) => { const step = () => { sc.scrollTop += 120; frames++; if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 || frames > 600) res(); else requestAnimationFrame(step); }; step(); });
  return { frames, ms: Math.round(performance.now() - t0) };
});
i = await info();
check('still few rows after scrolling to the end', i.dom < 60, `${i.dom} rows, ${fps.frames} frames in ${fps.ms} ms`);

// sort by size, biggest first
await page.click('.rfm-view [data-col="size"] .sort-button.desc');
await page.waitForTimeout(500);
const sizes = await page.evaluate(() => [...document.querySelectorAll('.rfm-view .rm-pages-row:not(.rm-pages-row-header) .rfm-col-size')].slice(0, 5).map((e) => e.textContent));
check('sorts by size', /MB|GB/.test(sizes[0]), sizes.join(', '));
await page.screenshot({ path: path.join(OUT, '2-by-size.png') });

// search
await page.fill('.rfm-view .search-input', 'pdf');
await page.waitForTimeout(400);
i = await info();
check('search narrows the list', i.total > 0 && i.total < 100, `${i.total} match "pdf"`);
await page.fill('.rfm-view .search-input', '');

// filter: nothing unused in a graph just scanned; trash stays off
await page.click('.rfm-view .bp3-icon-filter');
await page.evaluate(() => [...document.querySelectorAll('.bp3-popover label')].find((e) => e.textContent.trim() === 'Unused').querySelector('input').click());
await page.waitForTimeout(400);
i = await info();
check('Unused filter shows nothing when every file is in use', i.total === 0);
await page.screenshot({ path: path.join(OUT, '3-filter.png') });
await page.evaluate(() => [...document.querySelectorAll('.bp3-popover label')].find((e) => e.textContent.trim() === 'Unused').querySelector('input').click());
await page.mouse.click(700, 700);
await page.evaluate(() => document.querySelector('.rfm-view .rm-pages-row:not(.rm-pages-row-header) input').click());
check('trash is off for a file that is in use', await page.evaluate(() => document.querySelector('.rfm-view .bp3-icon-trash').disabled));

// the page link opens the block; the view goes away
await page.click('.rfm-view .rfm-page-link');
await page.waitForTimeout(1500);
check('a page link leaves the list and opens the block', await page.evaluate(() => !document.querySelector('.rfm-view') && !!document.querySelector('.roam-article')), await page.evaluate(() => location.hash));
// back to the list, then Roam's own navigation closes it
await page.click('.rm-left-sidebar__all-files');
await page.waitForSelector('.rfm-view');
await page.click('.rm-left-sidebar__daily-notes');
await page.waitForTimeout(1500);
check('Daily Notes closes the list', await page.evaluate(() => !document.querySelector('.rfm-view')));
// from Daily Notes, back to Daily Notes: no route change, and the list still closes
await page.click('.rm-left-sidebar__all-files');
await page.waitForSelector('.rfm-view');
await page.click('.rm-left-sidebar__daily-notes');
await page.waitForTimeout(1500);
check('Daily Notes closes the list when Roam was already on Daily Notes', await page.evaluate(() => !document.querySelector('.rfm-view') && !!document.querySelector('.roam-log-container')));
await page.click('.rm-left-sidebar__all-files');
await page.waitForSelector('.rfm-view');
await page.click('.rm-left-sidebar__all-pages');
await page.waitForTimeout(1500);
check('All Pages closes the list', await page.evaluate(() => !document.querySelector('.rfm-view') && !!document.querySelector('#all-pages-search')));

// unload leaves nothing behind
await page.click('.rm-left-sidebar__all-files');
await page.waitForSelector('.rfm-view');
await page.evaluate(() => window.__ext.onunload());
await page.waitForTimeout(800);
check('unload removes the row, the view and the styles', await page.evaluate(() => !document.querySelector('.rm-left-sidebar__all-files, .rfm-view, style[data-roam-file-manager]')));

await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `${failed.length} of ${checks.length} checks FAILED` : `all ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
