// The built extension next to Roam's own Linked References, in Roam's public help graph (the real
// web app, headless, no sign-in). The same made-up notes are written twice: as pages in the graph
// (the help graph takes writes in memory only, so nothing is saved anywhere) and as a vault of the
// files Roam's Markdown export makes of those pages. Then one page shows both sections, and each
// vault reference is compared with Roam's reference for the same block: text, elements, positions,
// colours and sizes.
//
//   npm run build && node test/help-graph.mjs [out-dir]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = path.resolve(process.argv[2] || 'help-graph-out');
fs.mkdirSync(OUT, { recursive: true });
const code = fs.readFileSync(new URL('../dist/extension.js', import.meta.url), 'utf8');
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok }); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); };

// A bakery's notes. Each page is a tree of blocks: [text, children].
const PAGE = 'Sourdough';
export const PAGES = {
  [PAGE]: [['Starter fed at 7 and 19'], ['Bulk at 26°, four folds']],
  Wholesale: [
    ['Week of July 13th–19th, 2026', [
      ['[[July 13th, 2026]]', [
        ['Tasting with [[Harbour Cafe]]', [
          ['~6 standing orders at 20–40 loaves, twice a week ([[Sourdough]], [Rye]([[Dark rye]]), Baguette, [[Focaccia]], #wholesale)', [
            ['{{[[TODO]]}} send the price list by Friday'],
            ['delivery by 7', [['back door, ask for **Inés**']]],
          ]],
        ]],
      ]],
    ]],
    ['Week of July 6th–12th, 2026', [
      ['[[July 8th, 2026]]', [
        ['[[Sourdough]] trial bake with [[Tomás Lindqvist]] — two proofs, ^^18 hours^^ cold, then the stone deck.'],
      ]],
    ]],
  ],
  'July 9th, 2026': [['Oven:: [[Sourdough]] at 250° with steam, __then__ 220° dry'], ['Flour order arrived']],
};
/** A page as Roam's Markdown export writes it: "- " blocks, four spaces a level. */
export const exported = (blocks, depth = 0) => blocks.map(([text, kids = []]) => `${'    '.repeat(depth)}- ${text}\n${exported(kids, depth + 1)}`).join('');
// The vault: the export of those pages, the daily note filed by year as in a vault kept by hand.
/** A made-up picture, 320 x 200: a PNG of bands of colour. */
function picture() {
  const W = 320, H = 200, raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) raw.set([180 + ((x >> 4) % 2) * 40, 140 + ((y >> 4) % 2) * 40, 90], y * (1 + W * 3) + 1 + x * 3);
  const chunk = (type, data) => { const b = Buffer.concat([Buffer.from(type), data]), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(b)); return Buffer.concat([len, b, crc]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(W, 0); head.writeUInt32BE(H, 4); head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const STEPS = ['Mix', 'Rest', 'Knead', 'Butter in', 'Knead again', 'Bulk', 'Fold', 'Chill', 'Shape', 'Proof', 'Egg wash', 'Bake'];
const TABLE = [['Loaf', 'Flour', 'Hours'], ['**Brioche**', 'white [[T45]]', '16'], ['Rye', 'dark', '18']];
// A block that names another block: Roam's ((uid)), Obsidian's [[Note#^id]]. And a link to a heading.
const COLD = 'Cold proof: **18 hours** at 4°';
const FILES = {
  'Proofing.md': `## Warm\n\n- two hours at 26°\n\n## Cold\n\n- ${COLD} ^cold\n`,
  'Rota.md': '- [[Focaccia]] goes in after ((the cold proof))\n- [[Focaccia]] timing: see [[Proofing#Cold]]\n'.replace('((the cold proof))', '[[Proofing#^cold]]'),
  // embeds: a block, a heading with what is under it, a whole note, and a picture kept in the vault
  'Embeds.md': '- [[Ciabatta]] block ![[Proofing#^cold]]\n- [[Ciabatta]] heading ![[Proofing#Warm]]\n- [[Ciabatta]] note ![[Proofing]]\n- [[Ciabatta]] crumb ![open crumb](pictures/crumb.png)\n',
  // a property that links: Roam's attribute block
  'Rye notes.md': '---\nrelated: "[[Ciabatta]]"\ntags: [bread, rye]\n---\nDense crumb.\n',
  // a numbered list under a line, and a table (embedded by its id, as Obsidian names a table)
  'Brioche plan.md': `- [[Brioche]] steps\n${STEPS.map((t, i) => `    ${i + 1}. ${t}\n`).join('')}- [[Brioche]] table ![[Brioche plan#^amounts]]\n\n${TABLE.map((r, i) => `| ${r.join(' | ')} |\n${i ? '' : '| --- | --- | --- |\n'}`).join('')}\n^amounts\n`,
  'pictures/crumb.png': picture(),
  // an OKF bundle: notes named by their title, type and status as pages, paths from the note's folder
  'kb/index.md': '---\nokf_version: "0.3"\ntitle: Bakery suppliers\n---\n# Mills\n\n* [Stone Mill](mills/stone-mill.md)\n',
  'kb/mills/stone-mill.md': '---\ntype: Supplier\ntitle: Stone Mill\nstatus: stable\n---\n# Flour\n\nRye and spelt, delivered on Mondays. See [the rye order](../orders/rye.md).\n',
  'kb/orders/rye.md': '---\ntype: Order\ntitle: Weekly rye order\n---\nTwenty sacks.\n',
  'Wholesale.md': exported(PAGES.Wholesale), 'Days/2026/July 9th, 2026.md': exported(PAGES['July 9th, 2026']), 'Sourdough.md': exported(PAGES[PAGE]) };

const browser = await chromium.launch({ env: { ...process.env, LC_ALL: 'C.UTF-8' } });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })).newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message.slice(0, 300)); });
await page.route('https://example.com/pictures/crumb.png', (r) => r.fulfill({ contentType: 'image/png', body: picture() }));
await page.goto('https://roamresearch.com/#/app/help', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.roamAlphaAPI && document.querySelector('.rm-title-display, .roam-log-container'), null, { timeout: 90000 });
await page.waitForTimeout(3000);
await page.addStyleTag({ content: '.bp3-portal .bp3-toast-container{display:none!important}' }); // the help graph's own warning

// the pages, in the graph's memory
await page.evaluate(async ({ PAGES, COLD, STEPS, TABLE }) => {
  const api = window.roamAlphaAPI;
  let n = 0;
  const add = async (parent, blocks) => {
    for (const [i, [string, kids = []]] of blocks.entries()) {
      const uid = `rvhg${String(++n).padStart(5, '0')}`;
      try { await api.createBlock({ location: { 'parent-uid': parent, order: i }, block: { string, uid, open: true } }); } catch (e) { throw new Error(`block ${string}: ${e?.message ?? e}`); }
      await add(uid, kids);
    }
  };
  for (const [title, blocks] of Object.entries(PAGES)) {
    // a page some block already linked to exists by now; a daily note's uid is its date
    const uid = api.pull('[:block/uid]', [':node/title', title])?.[':block/uid'] ?? `rvhgp${String(++n).padStart(4, '0')}`;
    try { await api.createPage({ page: { title, uid } }); } catch (e) { if (!api.pull('[:block/uid]', [':node/title', title])) throw new Error(`page ${title}: ${e?.message ?? e}`); }
    await add(api.pull('[:block/uid]', [':node/title', title])[':block/uid'], blocks);
  }
  await api.createPage({ page: { title: 'Supplier', uid: 'rvhgsuppl' } });
  if (!api.pull('[:block/uid]', [':node/title', 'Oven'])) await api.createPage({ page: { title: 'Oven', uid: 'rvhgoven0' } });
  await api.createPage({ page: { title: 'Proofing', uid: 'rvhgproof' } });
  await api.createBlock({ location: { 'parent-uid': 'rvhgproof', order: 0 }, block: { string: 'Warm', uid: 'rvhgwarm0', heading: 2, open: true } });
  await api.createBlock({ location: { 'parent-uid': 'rvhgwarm0', order: 0 }, block: { string: 'two hours at 26°', uid: 'rvhgwarm1' } });
  await api.createBlock({ location: { 'parent-uid': 'rvhgproof', order: 1 }, block: { string: 'Cold', uid: 'rvhgcold0', heading: 2, open: true } });
  await api.createBlock({ location: { 'parent-uid': 'rvhgcold0', order: 0 }, block: { string: COLD, uid: 'rvhgcold1' } });
  await api.createPage({ page: { title: 'Rye notes', uid: 'rvhgryeno' } });
  await api.createBlock({ location: { 'parent-uid': 'rvhgryeno', order: 0 }, block: { string: 'related:: [[Ciabatta]]', uid: 'rvhgryen1' } });
  await api.createPage({ page: { title: 'Brioche plan', uid: 'rvhgbrio0' } });
  await api.createBlock({ location: { 'parent-uid': 'rvhgbrio0', order: 0 }, block: { string: '[[Brioche]] steps', uid: 'rvhgbrio1', 'children-view-type': 'numbered' } });
  for (const [i, string] of STEPS.entries()) await api.createBlock({ location: { 'parent-uid': 'rvhgbrio1', order: i }, block: { string, uid: 'rvhgstep' + String.fromCharCode(97 + i) } });
  await api.createBlock({ location: { 'parent-uid': 'rvhgbrio0', order: 1 }, block: { string: '[[Brioche]] table {{[[embed]]: ((rvhgtable))}}', uid: 'rvhgbrio2' } });
  await api.createBlock({ location: { 'parent-uid': 'rvhgbrio0', order: 2 }, block: { string: '{{[[table]]}}', uid: 'rvhgtable', open: false } });
  for (const [y, row] of TABLE.entries()) { let parent = 'rvhgtable'; for (const [x, string] of row.entries()) { const uid = `rvhgtd${y}${x}x`; await api.createBlock({ location: { 'parent-uid': parent, order: x ? 0 : y }, block: { string, uid, open: true } }); parent = uid; } }
  await api.createPage({ page: { title: 'Embeds', uid: 'rvhgembed' } });
  for (const [i, string] of ['[[Ciabatta]] block {{[[embed]]: ((rvhgcold1))}}', '[[Ciabatta]] heading {{[[embed]]: ((rvhgwarm0))}}', '[[Ciabatta]] note {{[[embed]]: [[Proofing]]}}', '[[Ciabatta]] crumb ![open crumb](https://example.com/pictures/crumb.png)'].entries())
    await api.createBlock({ location: { 'parent-uid': 'rvhgembed', order: i }, block: { string, uid: 'rvhgembe' + i } });
  await api.createPage({ page: { title: 'Rota', uid: 'rvhgrota1' } });
  await api.createBlock({ location: { 'parent-uid': 'rvhgrota1', order: 0 }, block: { string: '[[Focaccia]] goes in after ((rvhgcold1))', uid: 'rvhgrota2' } });
}, { PAGES, COLD, STEPS, TABLE });

// the vault, in the browser's private file system, connected through the folder picker (stubbed)
await page.evaluate(async ({ FILES, code }) => {
  const root = await navigator.storage.getDirectory();
  const vault = await root.getDirectoryHandle('Bakery', { create: true });
  for (const [rel, text] of Object.entries(FILES)) {
    const parts = rel.split('/'); let d = vault;
    for (const s of parts.slice(0, -1)) d = await d.getDirectoryHandle(s, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(typeof text === 'string' ? text : new Uint8Array(text)); await w.close();
  }
  window.showDirectoryPicker = async () => vault;
  const ext = (await import(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))).default;
  window.__ext = ext;
  let cfg; const stored = {};
  await ext.onload({ extensionAPI: { settings: { panel: { create: (c) => { cfg = c; } }, get: (k) => stored[k], set: (k, v) => { stored[k] = v; } } } });
  // The settings tab's component, drawn by Roam's own React in a box of its own.
  const box = document.createElement('div'); box.style.display = 'none'; document.body.append(box);
  window.ReactDOM.render(window.React.createElement(cfg.settings.find((s) => s.action?.component).action.component), box);
  await new Promise((r) => setTimeout(r, 300));
  [...box.querySelectorAll('button')].find((b) => b.textContent === 'Add vault folder').click();
}, { FILES: Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, typeof v === 'string' ? v : [...v]])), code });

const back = async () => { await page.goBack(); await page.waitForSelector('.roam-article .rv-panel .rm-reference-item'); await page.waitForTimeout(400); };
const open = async (title) => {
  await page.evaluate((title) => window.roamAlphaAPI.ui.mainWindow.openPage({ page: { title } }), title);
  await page.waitForFunction((title) => document.querySelector('.roam-article .rm-title-display')?.textContent === title, title);
};
await open(PAGE);
await page.waitForSelector('.rv-panel .rm-reference-item', { timeout: 30000 });
await page.waitForTimeout(800);
const shot = async (name, sel = '.roam-article') => { await page.locator(sel).first().screenshot({ path: path.join(OUT, name) }); };
await shot('1-both-sections.png');

// ---------- the same reference, drawn by Roam and drawn from the vault ----------
/** What is measured of each reference: where its parts are inside its grey box, and how they are
 *  drawn; and of each group, where its title row and boxes are. */
const measure = () => page.evaluate(() => {
  const GROUP = { caret: '.rm-title-arrow-wrapper > .rm-caret', title: '.rm-ref-page-view-title', item: '.rm-reference-item' };
  const ITEM = {
    crumbs: '.rm-zoom', crumb: '.rm-zoom-item-content', chevron: '.rm-mention-icon', controls: '.rm-block__controls', caret: '.block-expand .rm-caret', bullet: '.rm-bullet__inner',
    text: '.rm-block-text', link: '.rm-block-text .rm-page-ref--link', bracket: '.rm-block-text .rm-page-ref__brackets', tag: '.rm-page-ref--tag', alias: '.rm-alias', bold: '.rm-bold', italic: '.rm-italics',
    highlight: '.rm-highlight', blockref: '.rm-block-ref', number: '.rm-bullet__inner--numbered', embed: '.rm-embed-container', embedbar: '.rm-embed-margin-action', embedtitle: 'h3.rm-page__title', img: '.rm-inline-img', imgbox: '.rm-inline-img__resize', attr: '.rm-attr-ref', checkbox: '.checkmark', kids: '.rm-block-children', multibar: '.rm-multibar',
  };
  const STYLE = ['color', 'backgroundColor', 'fontSize', 'lineHeight', 'fontWeight', 'fontStyle', 'opacity', 'marginTop', 'marginLeft', 'paddingTop', 'paddingLeft', 'borderTopColor', 'borderTopWidth'];
  const r1 = (n) => Math.round(n * 10) / 10;
  const parts = (root, sels) => {
    const o = root.getBoundingClientRect(), out = {};
    for (const [k, sel] of Object.entries(sels)) {
      out[k] = [...root.querySelectorAll(sel)].filter((e) => e.getClientRects().length || k === 'crumbs').map((e) => {
        const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
        return { x: r1(r.left - o.left), y: r1(r.top - o.top), w: r1(r.width), h: r1(r.height), ...Object.fromEntries(STYLE.map((p) => [p, cs[p]])) };
      });
    }
    return out;
  };
  /** What an element says, without Roam's counts of references to an embedded block or page. */
  const said = (e) => e.innerText.split('\n').filter((l) => !/^\d+$/.test(l)).join('\n');
  const groups = (root) => Object.fromEntries([...root.querySelectorAll('.rm-ref-page-view')].map((g) => {
    const title = g.querySelector('.rm-page__title').textContent;
    const p = parts(g, GROUP);
    for (const t of p.title) delete t.w; // a vault title has the note's folders before its name
    for (const i of p.item) { delete i.y; delete i.h; } // Roam's order inside a page is its own; each box is measured below
    const items = Object.fromEntries([...g.querySelectorAll('.rm-reference-item')].map((it) => [said(it.querySelector('.rm-block__input')), { parts: parts(it, ITEM), text: [...it.querySelectorAll('.rm-zoom-item-content, .rm-block__input')].map(said) }]));
    return [title.slice(title.lastIndexOf('/') + 1), { parts: p, items, height: r1(g.getBoundingClientRect().height) }];
  }));
  const left = (e) => r1(e.getBoundingClientRect().left);
  const roamRoot = document.querySelector('.roam-article .rm-reference-container'), ours = document.querySelector('.roam-article .rv-panel');
  return {
    roam: groups(roamRoot), vault: groups(ours),
    heads: [roamRoot.querySelector('strong'), ours.querySelector('strong')].map((s) => ({ x: left(s), color: getComputedStyle(s).color, weight: getComputedStyle(s).fontWeight, text: s.textContent })),
    groupsLeft: [left(roamRoot.querySelector('.rm-ref-page-view')), left(ours.querySelector('.rm-ref-page-view'))],
  };
});
const differ = (a, b, out, at = '') => {
  for (const k of Object.keys(a)) {
    if (a[k].length !== b[k].length) { out.push(`${at}${k}: ${a[k].length} in Roam, ${b[k].length} from the vault`); continue; }
    a[k].forEach((x, i) => { for (const p of Object.keys(x)) if (x[p] !== b[k][i][p] && !(typeof x[p] === 'number' && Math.abs(x[p] - b[k][i][p]) <= 0.5)) out.push(`${at}${k}[${i}].${p}: ${x[p]} in Roam, ${b[k][i][p]} from the vault`); });
  }
};
const compare = (m, what) => {
  check(`${what}: both headers start at the same place, in the same grey`, m.heads[0].x === m.heads[1].x && m.heads[0].color === m.heads[1].color && m.heads[0].weight === m.heads[1].weight, JSON.stringify(m.heads));
  check(`${what}: note groups start where Roam's page groups do`, m.groupsLeft[0] === m.groupsLeft[1], JSON.stringify(m.groupsLeft));
  for (const [name, r] of Object.entries(m.roam)) {
    const v = m.vault[name];
    if (!v) { check(`${what}: "${name}" is listed from the vault`, false); continue; }
    const texts = (g) => JSON.stringify(Object.values(g.items).map((i) => i.text).sort());
    check(`${what}: "${name}" reads the same`, texts(r) === texts(v), `\n  roam  ${texts(r)}\n  vault ${texts(v)}`);
    const diffs = [];
    differ(r.parts, v.parts, diffs);
    if (r.height !== v.height) diffs.push(`height: ${r.height} in Roam, ${v.height} from the vault`);
    let n = Object.values(r.parts).flat().length;
    for (const [text, item] of Object.entries(r.items)) {
      if (!v.items[text]) continue;
      differ(item.parts, v.items[text].parts, diffs, `"${text.slice(0, 24)}…" `);
      n += Object.values(item.parts).flat().length;
    }
    check(`${what}: "${name}" is drawn the same (place, size and style of ${n} parts)`, !diffs.length, '\n  ' + diffs.slice(0, 40).join('\n  '));
  }
};
compare(await measure(), 'brackets shown');

// children: folded at first in both, shown by the caret in both
const carets = (root) => page.locator(`${root} .rm-reference-item > div > .roam-block-container > .rm-block-main .block-expand .rm-caret`);
for (const root of ['.roam-article .rm-reference-container', '.roam-article .rv-panel']) {
  for (const c of await carets(root).all()) { await c.locator('xpath=ancestor::div[contains(@class,"rm-block-main")]').hover(); await page.waitForTimeout(300); if ((await c.evaluate((e) => getComputedStyle(e).opacity)) !== '0') await c.click(); }
}
await page.mouse.move(5, 5);
await page.waitForTimeout(500);
check('the caret shows a reference\'s children, in the vault as in Roam', await page.evaluate(() => document.querySelectorAll('.rv-panel .rm-block-children .roam-block-container').length === 2 && document.querySelectorAll('.rm-reference-container .rm-block-children .roam-block-container').length === 2));
compare(await measure(), 'children shown');
await shot('3-children-shown.png');

// Roam's bracket setting (Ctrl-C Ctrl-B): vault lines follow it
const brackets = () => page.evaluate(() => [document.querySelectorAll('.rm-reference-container .rm-page-ref__brackets').length, [...document.querySelectorAll('.rv-panel .rm-page-ref__brackets')].filter((b) => b.getClientRects().length).length]);
const b0 = await brackets();
await page.locator('.rm-title-display').first().click({ position: { x: 600, y: 5 } }).catch(() => {});
await page.keyboard.press('Escape');
await page.keyboard.press('Control+c'); await page.keyboard.press('Control+b');
await page.waitForTimeout(600);
const b1 = await brackets();
check('brackets show in vault lines while Roam shows its own', b0[0] > 0 && b0[1] === b0[0], JSON.stringify(b0));
check('hiding brackets in Roam hides them in vault lines', b1[0] === 0 && b1[1] === 0, JSON.stringify(b1));
compare(await measure(), 'brackets hidden');
await shot('2-brackets-hidden.png');

// the path above a reference: a click on a part shows that parent in place, the reference marked
const crumb = (root, n) => page.locator(`${root} .rm-reference-item`, { hasText: 'standing orders' }).locator('.rm-zoom-item').nth(n);
for (const root of ['.roam-article .rm-reference-container', '.roam-article .rv-panel']) await crumb(root, 2).click();
await page.mouse.move(5, 5);
await page.waitForTimeout(600);
const opened = () => page.evaluate(() => ['.rm-reference-container', '.rv-panel'].map((root) => {
  const item = [...document.querySelectorAll(`.roam-article ${root} .rm-reference-item`)].find((i) => i.textContent.includes('standing orders'));
  return { crumbs: item.querySelectorAll('.rm-zoom-item').length, blocks: [...item.querySelectorAll('.rm-block-text')].map((b) => b.innerText), marked: [...item.querySelectorAll('.block-highlight-yellow')].map((b) => b.querySelector('.rm-block-text').innerText) };
}));
let o = await opened();
check('a click on the last part of a path shows that parent as a block, the reference marked under it, as in Roam', o[1].crumbs === 2 && JSON.stringify(o[0]) === JSON.stringify(o[1]) && o[1].marked.length === 1, JSON.stringify(o));
compare(await measure(), 'a parent shown in place');
await shot('4-parent-shown-in-place.png');
for (const root of ['.roam-article .rm-reference-container', '.roam-article .rv-panel']) await crumb(root, 0).click();
await page.mouse.move(5, 5);
await page.waitForTimeout(600);
o = await opened();
check('a click on the first part shows the whole path as nested blocks', o[1].crumbs === 0 && JSON.stringify(o[0]) === JSON.stringify(o[1]), JSON.stringify(o));
compare(await measure(), 'the whole path shown in place');

// links in a vault line open Roam's pages, as Roam's own links do
const link = () => page.locator('.rv-panel .rm-block-text .rm-page-ref--link', { hasText: 'Tomás Lindqvist' });
await link().click({ modifiers: ['Shift'] });
await page.waitForTimeout(600);
const side = await page.evaluate(() => window.roamAlphaAPI.ui.rightSidebar.getWindows().map((w) => [w.type, window.roamAlphaAPI.pull('[:node/title]', [':block/uid', w['page-uid'] ?? w['block-uid']])?.[':node/title']]));
check('shift-click on a link opens its page in the right sidebar', JSON.stringify(side) === JSON.stringify([['outline', 'Tomás Lindqvist']]), JSON.stringify(side));
await link().click({ modifiers: ['Control', 'Shift'] });
await page.waitForTimeout(600);
check('ctrl-shift-click opens the page\'s linked references there', await page.evaluate(() => window.roamAlphaAPI.ui.rightSidebar.getWindows().some((w) => w.type === 'mentions')));
await shot('5-link-opened-in-sidebar.png', '.roam-body-main, .roam-app');
await page.evaluate(async () => { for (const w of window.roamAlphaAPI.ui.rightSidebar.getWindows()) await window.roamAlphaAPI.ui.rightSidebar.removeWindow({ window: { type: w.type, 'block-uid': w['page-uid'] ?? w['block-uid'] ?? w['mentions-uid'] } }); await window.roamAlphaAPI.ui.rightSidebar.close(); });
await link().click();
await page.waitForFunction(() => document.querySelector('.roam-article .rm-title-display')?.textContent === 'Tomás Lindqvist', null, { timeout: 5000 }).catch(() => {});
check('a click on a link opens its page in Roam', (await page.locator('.roam-article .rm-title-display').first().textContent()) === 'Tomás Lindqvist');
await page.waitForSelector('.rv-panel .rm-reference-item');
check('and that page lists the vault\'s line about it', (await page.locator('.rv-panel').textContent()).includes('trial bake'));

// a whole note, unfolded under its title: an outline of blocks
await open(PAGE);
await page.waitForSelector('.rv-panel .rm-reference-item');
await page.locator('.rv-panel .rv-group-caret').first().click();
await page.waitForSelector('.rv-panel .rv-preview .roam-block-container');
check('the note that is the page unfolds into its blocks', JSON.stringify(await page.locator('.rv-panel .rv-preview .rm-block-text').allInnerTexts()) === JSON.stringify(PAGES[PAGE].map((b) => b[0])));
await shot('6-note-unfolded.png');
// the bullet opens the note at that block
await page.locator('.rv-panel .rm-reference-item', { hasText: 'trial bake' }).locator('.rm-bullet').first().click();
await page.waitForSelector('.rv-note-page .roam-block-container');
check('a click on a bullet opens the note with that block marked', (await page.locator('.rv-note-page .block-highlight-yellow .rm-block-text').innerText()).includes('trial bake'));
await page.screenshot({ path: path.join(OUT, '7-note-opened.png') });
// the note is where a page would be: its title where the page's title was, the same size
const titleOf = () => page.evaluate(() => { const t = document.querySelector('.roam-article .rm-title-display'), r = t.getBoundingClientRect(), cs = getComputedStyle(t); return [Math.round(r.left), Math.round(r.top), cs.fontSize, cs.fontWeight, cs.color].join(' '); });
const noteTitle = await titleOf();
check('the note opens in the main window, named by its file', (await page.locator('.rv-note-page .rm-title-display').innerText()) === 'Wholesale' && await page.evaluate(async () => (await window.roamAlphaAPI.ui.mainWindow.getOpenView()).type === 'custom'));
await back();
check('Back returns to the page', (await page.locator('.roam-article .rm-title-display').first().textContent()) === PAGE && (await page.locator('.rv-note-page').count()) === 0, await page.evaluate(async () => JSON.stringify([[...document.querySelectorAll('.rm-title-display')].map((t) => t.textContent), document.querySelectorAll('.rv-note-page').length, await window.roamAlphaAPI.ui.mainWindow.getOpenView(), location.hash, history.state])));
check('the note\'s title is drawn where the page\'s is', noteTitle === await titleOf(), `${noteTitle} / ${await titleOf()}`);
await page.goForward();
await page.waitForSelector('.rv-note-page .block-highlight-yellow');
check('Forward comes back to the note, at its block', (await page.locator('.rv-note-page .block-highlight-yellow .rm-block-text').innerText()).includes('trial bake'));
await back();
// shift-click, which in Roam opens the sidebar: the dialog over the page
await page.locator('.rv-panel .rm-reference-item', { hasText: 'trial bake' }).locator('.rm-bullet').first().click({ modifiers: ['Shift'] });
await page.waitForSelector('.rv-viewer .block-highlight-yellow');
check('shift-click on a bullet opens the note over the page', (await page.locator('.rv-note-page').count()) === 0);
await page.keyboard.press('Escape');

// ---------- a block that names another block, and a link to a heading ----------
await open('Focaccia');
await page.waitForSelector('.rv-panel .rm-reference-item');
await page.waitForFunction((t) => document.querySelector('.rv-panel .rm-block-ref')?.textContent === t, COLD.replaceAll('*', ''));
await page.waitForTimeout(500);
await shot('8-block-reference.png');
{
  const m = await measure();
  const only = (g) => ({ Rota: g.Rota && { ...g.Rota, parts: { caret: g.Rota.parts.caret, title: g.Rota.parts.title }, height: 0, items: Object.fromEntries(Object.entries(g.Rota.items).filter(([t]) => t.includes('goes in after'))) } });
  compare({ ...m, roam: only(m.roam), vault: only(m.vault) }, 'block reference');
}
await page.locator('.rv-panel .rm-block-ref').click();
await page.waitForSelector('.rv-note-page .roam-block-container');
check('a click on a block reference opens the note with that block marked', (await page.locator('.rv-note-page .block-highlight-yellow .rm-block-text').first().innerText()) === COLD.replaceAll('*', ''));
await back();
const head = page.locator('.rv-panel .rm-page-ref--link', { hasText: 'Proofing > Cold' });
check('a link to a heading reads "Note > Heading"', await head.count() === 1);
await head.click();
await page.waitForSelector('.rv-note-page .roam-block-container');
check('and opens the note with the heading marked', (await page.locator('.rv-note-page .block-highlight-yellow .rm-block-text').first().innerText()) === 'Cold');
await page.screenshot({ path: path.join(OUT, '9-heading-opened.png') });
await back();

// ---------- embeds and a picture from the vault ----------
await page.setViewportSize({ width: 1440, height: 1800 });
await open('Ciabatta');
await page.waitForSelector('.rv-panel .rm-embed--page');
await page.waitForFunction(() => [...document.querySelectorAll('.roam-article .rm-inline-img')].length === 2 && [...document.querySelectorAll('.roam-article .rm-inline-img')].every((i) => i.complete && i.naturalWidth === 320));
await page.waitForTimeout(800);
await shot('10-embeds.png');
compare(await measure(), 'embeds');
for (const root of ['.roam-article .rm-reference-container', '.roam-article .rv-panel']) await page.locator(`${root} .rm-embed--page > .rm-embed-margin-action`).click();
await page.waitForSelector('.rv-panel .rm-embed__content .roam-block-container');
await page.waitForTimeout(800);
await shot('11-note-embed-open.png');
check('the bar at a note embed\'s left opens the note in place, as a page embed opens in Roam', JSON.stringify(await page.locator('.rv-panel .rm-embed__content .rm-block-text').allInnerTexts()) === JSON.stringify(await page.locator('.rm-reference-container .rm-embed__content > .rm-block-children .rm-block-text').allInnerTexts()));
check('a page embedded by Roam lists its own vault references, not the page\'s', await page.evaluate(() => document.querySelector('.rm-reference-container .rm-embed--page .rv-panel')?.dataset.title === 'Proofing'));

// ---------- a numbered list and a table ----------
await open('Brioche');
await page.waitForSelector('.rv-panel .rm-table td');
await page.waitForTimeout(500);
for (const root of ['.roam-article .rm-reference-container', '.roam-article .rv-panel']) {
  const item = page.locator(`${root} .rm-reference-item`, { hasText: 'steps' });
  await item.locator('.rm-block-main').first().hover();
  await item.locator('.block-expand .rm-caret').first().click();
}
await page.mouse.move(5, 5);
await page.waitForSelector('.rv-panel .rm-bullet__inner--numbered');
await page.waitForTimeout(500);
await shot('12-numbered-and-table.png');
{
  const m = await measure();
  const only = (g) => ({ 'Brioche plan': g['Brioche plan'] && { ...g['Brioche plan'], parts: { caret: g['Brioche plan'].parts.caret, title: g['Brioche plan'].parts.title }, height: 0, items: Object.fromEntries(Object.entries(g['Brioche plan'].items).filter(([t]) => t.includes('steps'))) } });
  compare({ ...m, roam: only(m.roam), vault: only(m.vault) }, 'numbered list');
  // the table: every cell's place, size and style inside the table, and what it says
  const tables = await page.evaluate(() => ['.roam-article .rm-reference-container', '.roam-article .rv-panel'].map((root) => {
    const t = document.querySelector(`${root} .rm-table table`), o = t.getBoundingClientRect(), r1 = (n) => Math.round(n * 10) / 10;
    return [...t.querySelectorAll('td')].map((td) => { const r = td.getBoundingClientRect(), cs = getComputedStyle(td), c = td.querySelector('.rm-table__cell'), cc = getComputedStyle(c);
      return [c.innerText, r1(r.left - o.left), r1(r.top - o.top), r1(r.width), r1(r.height), cs.borderTopWidth, cs.borderTopColor, cs.padding, cs.backgroundColor, cc.fontSize, cc.fontWeight, cc.color, cc.padding, !!c.querySelector('.rm-bold'), !!c.querySelector('.rm-page-ref--link')].join(' | '); });
  }));
  check(`a Markdown table is Roam's table: ${tables[0].length} cells in the same place, size and style`, tables[0].length === 9 && JSON.stringify(tables[0]) === JSON.stringify(tables[1]), '\n  roam  ' + tables[0].join('\n        ') + '\n  vault ' + tables[1].join('\n        '));
}
fs.writeFileSync(path.join(OUT, 'measured.json'), JSON.stringify(await measure(), null, 1));

// ---------- an attribute's page ----------
// "Oven:: ..." on the daily page is a reference on the page Oven in Roam; the same line in the vault is one too
await open('Oven');
await page.waitForSelector('.rv-panel .rm-reference-item');
await page.waitForTimeout(500);
await shot('14-attribute-page.png');
compare(await measure(), 'an attribute\'s page');

// ---------- an OKF bundle ----------
await open('Supplier');
await page.waitForSelector('.rv-panel .rv-group-title');
await page.waitForTimeout(500);
await shot('13-okf-type-page.png');
check('a type\'s page lists the OKF notes of that type, each named by its title', (await page.locator('.rv-panel .rv-group-title').allInnerTexts()).map((t) => t.trim()).join() === 'kb/mills/Stone Mill');
check('the note\'s type is drawn as a page reference', (await page.locator('.rv-panel .rm-block-text .rm-page-ref', { hasText: 'Supplier' }).count()) === 1);
await page.locator('.rv-panel .rv-group-title a').first().click();
await page.waitForSelector('.rv-note-page .roam-block-container');
await page.waitForTimeout(300);
check('it opens as a page named by its title', (await page.locator('.rv-note-page .rm-title-display').innerText()) === 'Stone Mill');
check('its status is a page reference too', (await page.locator('.rv-note-page .rm-page-ref', { hasText: 'stable' }).count()) === 1);
await page.locator('.rv-note-page [data-rv-target]', { hasText: 'the rye order' }).click();
await page.waitForFunction(() => document.querySelector('.rv-note-page .rm-title-display')?.textContent === 'Weekly rye order', null, { timeout: 5000 }).catch(() => {});
check('a link is read from the note\'s folder, and opens the note it names', (await page.locator('.rv-note-page .rm-title-display').innerText()) === 'Weekly rye order');


check('no errors in the page', !errors.length, errors.join(' | ').slice(0, 500));
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length} of ${checks.length} checks pass`);
await browser.close();
process.exit(failed.length ? 1 : 0);
