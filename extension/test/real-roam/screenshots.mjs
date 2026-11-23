// Takes the README's screenshots in Roam's real desktop app (the Linux build, under Xvfb), signed in to
// the hosted test graph with the build loaded through Roam Depot's developer mode.
//
//   DISPLAY=:99 ROAM_EMAIL=… ROAM_PASSWORD=… OUT=docs/images node test/real-roam/screenshots.mjs
//
// Every picture shows the real extension at work on two small vaults about a garden and its recipes,
// written to a temporary folder, and on three pages it makes in the test graph when they are missing.
// The vaults are removed again when it is done. Credentials are handled as in run.mjs.
// See .github/workflows/screenshots.yml.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { genVault } from './genvault.mjs';
import {
  roam, log, sleep, evalIn, serve, stopServing, launchRoam, killRoam, waitFor, signIn, openGraph, dismissDialogs,
  openVaultsTab, loadDevExtension, addVault, statusOf, clickButton, clearExtensionState, touchAll, panelText, setSwitch,
} from './roam.mjs';

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;
const GRAPH = process.env.ROAM_GRAPH || 'vault-spike-hosted';
const DIST = path.resolve(process.env.DIST || path.join(import.meta.dirname, '../../dist'));
const OUT = path.resolve(process.env.OUT || path.join(import.meta.dirname, '../../../docs/images'));
const WIDTH = 1280, HEIGHT = 1000;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'real-roam-'));

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.startsWith('debug-')) fs.rmSync(path.join(OUT, f)); // from an earlier run
roam.logDir = WORK; // Roam's own log stays here: it isn't ours to publish

// The pages in the graph. Each entry is a block.
const PAGE = 'Tomatoes', SIMILAR_PAGE = 'Fertiliser schedule';
const PAGES = {
  [PAGE]: ['Sow indoors in March, plant out after the last frost', 'This year: San Marzano, Sungold and Black Krim', 'Feed every week once the first truss sets'],
  'Garden jobs': [`Order canes for the [[${PAGE}]]`, 'Turn the compost', 'Net the tomatoes before the blackbirds find them'],
  [SIMILAR_PAGE]: ['Ask at the allotment what they use on the squash'],
  Greenhouse: ['Open the vents on warm mornings'],
  // pages only the vaults talk about: a property's name, and an OKF type
  sunlight: [], Supplier: [],
};
// The vaults: folders of Markdown notes, as Obsidian keeps them.
const VAULTS = {
  Garden: {
    'Plants/Tomatoes.md': '---\naliases: [Tomato]\nsunlight: full sun\n---\n# Tomatoes\n\nCordon varieties need a cane or a string from the day they are planted out.\n\n- Pinch out the side shoots every week\n- Water at the base, never over the leaves\n- See [[Blight]] for what to watch for in August\n',
    'Journal/2026-05-14.md': '- Planted out the [[Tomatoes]] in bed 2, 45 cm apart\n- Sowed a second row of carrots\n',
    'Projects/Raised bed plan.md': '## Bed 2\n\n- [[Tomatoes]] along the back, basil in front\n- Leave room for a path on the north side\n',
    'Pests/Blight.md': '# Blight\n\nLate blight spreads fast in warm, wet weather.\n\n- Showed up on the [[Tomatoes]] after a wet week last August\n- Take off the leaves it is on and keep them out of the compost\n- Grow under cover if it comes back ^cover\n',
    'Seeds/Spring order.md': '- San Marzano and Sungold #tomatoes\n- Nantes carrots\n',
    'Journal/2026-06-02.md': '- Greenhouse\n    - Tied the [[Tomatoes]] in to the top wire\n        - Took off the leaves below the first truss\n        - Fed with comfrey tea\n- Paths\n    - Laid bark between beds 1 and 2\n',
    'Soil/Fertilizer schedule.md': '# Fertilizer schedule\n\n- Comfrey tea every two weeks from June\n- Seaweed feed when the fruit sets ^seaweed\n',
    // a block embedded, a block linked to, a heading embedded with what is under it
    'Journal/2026-07-01.md': '- [[Greenhouse]] feeding this month ![[Fertilizer schedule#^seaweed]]\n- [[Greenhouse]] door open on wet days: [[Blight#^cover]]\n- [[Greenhouse]] the beds ![[Raised bed plan#Bed 2]]\n',
    // properties: each name is a page, as an attribute's is in Roam
    'Plants/Basil.md': '---\nsunlight: full sun\nsown: 2026-04-02\nbed: "[[Raised bed plan]]"\n---\nPinch the tops out so it bushes.\n',
    // an OKF bundle: notes named by their title, their type a page
    'Suppliers/index.md': '---\nokf_version: "0.3"\ntitle: Seed suppliers\n---\n# Suppliers\n\n- [Heritage Seed Company](heritage-seeds.md)\n',
    'Suppliers/heritage-seeds.md': '---\ntype: Supplier\ntitle: Heritage Seed Company\nstatus: stable\n---\n# Orders\n\nTomato and basil seed, ordered in January. See [the spring order][order].\n\n[order]: ../Seeds/Spring%20order.md\n',
    '.obsidian/app.json': '{}',
  },
  Recipes: {
    'Sauces/Passata.md': '# Passata\n\n- 2 kg ripe [[Tomatoes]], halved\n- Simmer for 40 minutes, then sieve\n',
    'Preserving/Green tomato chutney.md': '- Uses up the last [[Tomatoes]] before the first frost\n',
    '.obsidian/app.json': '{}',
  },
};
const ARCHIVE = 'Archive', ARCHIVE_NOTES = +(process.env.NOTES || 20000); // a vault large enough to catch part way through a scan

/** Makes the pages that are missing, and the blocks a page doesn't have yet. */
const makePages = () => evalIn(async (PAGES) => {
  const api = window.roamAlphaAPI;
  const uidOf = (t) => api.data.q('[:find ?u . :in $ ?t :where [?p :node/title ?t] [?p :block/uid ?u]]', t);
  const blocksOf = (uid) => new Set(api.data.q('[:find ?s :in $ ?u :where [?p :block/uid ?u] [?p :block/children ?b] [?b :block/string ?s]]', uid).map((r) => r[0]));
  for (const [title, blocks] of Object.entries(PAGES)) {
    if (!uidOf(title)) await api.data.page.create({ page: { title, uid: api.util.generateUID() } });
    const page = uidOf(title);
    const have = blocksOf(page); // a page can be there already: from an earlier run, or made empty by a [[link]] to it
    for (const [order, string] of blocks.entries()) if (!have.has(string)) await api.data.block.create({ location: { 'parent-uid': page, order }, block: { string, uid: api.util.generateUID() } });
  }
  await new Promise((r) => setTimeout(r, 500));
}, PAGES);

const openPage = async (title) => {
  await dismissDialogs();
  await evalIn((title) => window.roamAlphaAPI.ui.mainWindow.openPage({ page: { title } }), title);
  await waitFor(`the page "${title}"`, () => evalIn((t) => document.querySelector('.roam-article .rm-title-display')?.textContent.trim() === t, title), 20000);
  await sleep(1500);
};

let cdp = null;
/** Starts Roam and opens the graph at twice the pixel density, so the pictures are sharp. */
async function start() {
  await launchRoam();
  await signIn(EMAIL, PASSWORD);
  await openGraph(GRAPH);
  cdp = await roam.page.context().newCDPSession(roam.page); // kept open: the override ends with it
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
  await sleep(1000);
}
/** The part of the window `selector` covers, for a cropped picture. */
const boxOf = (selector, pad = 0) => evalIn(([selector, pad, W, H]) => {
  const r = document.querySelector(selector)?.getBoundingClientRect();
  if (!r) return null;
  const x = Math.max(0, r.left - pad), y = Math.max(0, r.top - pad);
  return { x, y, width: Math.min(W, r.right + pad) - x, height: Math.min(H, r.bottom + pad) - y };
}, [selector, pad, WIDTH, HEIGHT]);
/** The page in the main window, from just above its title to just below `to`. */
async function pageBox(to = '.roam-article .rv-panel') {
  const article = await boxOf('.roam-article'), title = await boxOf('.roam-article .rm-title-display'), end = await boxOf(to);
  if (!article || !title || !end) throw new Error(`nothing to photograph at ${to}`);
  const y = Math.max(0, title.y - 24);
  return { x: article.x, y, width: article.width, height: Math.min(HEIGHT, end.y + end.height + 24) - y };
}
/** A note open in the main window, from just above its title to its end. */
async function noteBox() {
  const note = await boxOf('.rv-note-page'), title = await boxOf('.rv-note-page .rm-title-display');
  if (!note || !title) throw new Error('no note open in the main window');
  const y = Math.max(0, title.y - 24);
  return { x: note.x, y, width: note.width, height: Math.min(HEIGHT, note.y + note.height + 24) - y };
}
async function snap(name, clip) {
  if (!roam.signedIn) return; // never photograph the sign-in screen
  await evalIn(() => document.querySelectorAll('.bp3-toast .bp3-button').forEach((b) => b.click()));
  await sleep(400);
  // Straight from the page's own session: Playwright's screenshot puts its own 1x viewport back first.
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  log('saved', `${name}.png`, clip ? JSON.stringify(clip) : '');
}
/** The vault list's row in the settings tab: its name, description and the list. With `to`, the
 *  rows from it to the one named `to` as well. */
const settingsBox = async (to = 'Vaults') => {
  const marked = await evalIn((to) => {
    document.querySelectorAll('[data-rv-shot]').forEach((e) => e.removeAttribute('data-rv-shot'));
    const list = document.querySelector('.rv-settings');
    const named = (n) => [...n.querySelectorAll('*')].some((e) => e.children.length === 0 && e.textContent.trim() === to);
    // the smallest part of the tab that holds the list and the name `to`
    let n = list?.parentElement;
    while (n && !n.classList.contains('bp3-dialog') && !named(n)) n = n.parentElement;
    (n && !n.classList.contains('bp3-dialog') ? n : list)?.setAttribute('data-rv-shot', '');
    return !!list;
  }, to);
  if (!marked) throw new Error('the settings tab is not open');
  return boxOf('[data-rv-shot]', 16);
};
const noteCount = (files) => Object.keys(files).filter((f) => f.endsWith('.md')).length;

async function main() {
  serve(DIST);
  await start();
  await clearExtensionState();
  await loadDevExtension();
  await setSwitch('Reference counts', false); // settings sync through the graph: an earlier run may have left it on
  await makePages();

  for (const [name, files] of Object.entries(VAULTS)) {
    const dir = path.join(WORK, name);
    for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
    await addVault(dir);
    await waitFor(`${name} to finish scanning`, async () => (await statusOf(name)) === `${noteCount(files)} notes`, 30000);
  }

  // 1. The settings tab: the vault list and the editor field.
  await openVaultsTab();
  await snap('settings', await settingsBox('Open notes with'));

  // 2. A page with a note of its own, notes that link to it and a note tagged with it, from two vaults.
  await openPage(PAGE);
  await waitFor('External Vault References on the page', async () => { const t = await panelText(); return t.includes('External Vault References') && t.includes('Passata'); }, 20000);
  await sleep(500);
  await snap('one-section', await pageBox());

  // 3. The note that is the page, unfolded in place.
  await roam.page.locator('.roam-article .rv-group-caret').first().click();
  await waitFor('the note to unfold', () => evalIn(() => document.querySelector('.roam-article .rv-preview')?.innerText.includes('Pinch out')), 10000);
  await sleep(300);
  // the section from its heading to the end of the note after the unfolded one, with no row cut through
  const panel = await boxOf('.roam-article .rv-panel'), head = await boxOf('.roam-article .rv-sec-head'), next = await boxOf('.roam-article .rv-group:nth-child(2)');
  await snap('unfolded-note', { x: panel.x - 16, y: head.y - 12, width: panel.width + 32, height: next.y + next.height - head.y + 24 });
  await roam.page.locator('.roam-article .rv-group-caret').first().click();

  // 4. The note in the main window, opened from a line, with that line marked.
  await roam.page.locator('.roam-article .rv-panel .rm-block-main', { hasText: 'Showed up on the' }).locator('.rm-bullet').click();
  await waitFor('the note in the main window', () => evalIn(() => !!document.querySelector('.rv-note-page .rv-hl')), 10000);
  await sleep(500);
  await snap('note-viewer', await noteBox());
  await evalIn(() => history.back());
  await waitFor('the page again', async () => (await panelText()).includes('Passata'), 20000);
  await sleep(300);

  // 4b. A line from a nested list: the line it sits under above it, and its own children opened.
  const nested = roam.page.locator('.roam-article .rv-panel .rm-block-main', { hasText: 'Tied the' });
  await nested.hover();
  await sleep(300);
  await nested.locator('.rv-kids-caret').click();
  await waitFor('the children of the line', () => evalIn(() => document.querySelector('.roam-article .rv-panel')?.innerText.includes('Fed with comfrey tea')), 10000);
  await roam.page.mouse.move(5, 5);
  await sleep(300);
  await evalIn(() => [...document.querySelectorAll('.roam-article .rv-group')].find((g) => g.textContent.includes('Tied the'))?.setAttribute('data-rv-shot', ''));
  await snap('nested-line', await boxOf('.roam-article .rv-group[data-rv-shot]', 16));

  // 4c. Embeds and a link to a block: a block, the block linked to, and a heading with what is under it.
  await openPage('Greenhouse');
  await waitFor('the embeds on Greenhouse', async () => { const t = await panelText(); return t.includes('Seaweed feed') && t.includes('Grow under cover') && t.includes('basil in front'); }, 20000);
  await sleep(800);
  await snap('embeds', await pageBox());

  // 4d. A property's name is a page: the notes with a "sunlight" property.
  await openPage('sunlight');
  await waitFor('the notes with the property', async () => { const t = await panelText(); return t.includes('Basil') && t.includes('Tomatoes'); }, 20000);
  await sleep(500);
  await snap('property-page', await pageBox());

  // 4e. An OKF bundle: the type's page lists its notes by their titles; a note opens under its title.
  await openPage('Supplier');
  await waitFor('the OKF note on its type\'s page', async () => (await panelText()).includes('Heritage Seed Company'), 20000);
  await sleep(500);
  await snap('okf-type-page', await pageBox());
  await roam.page.locator('.roam-article .rv-panel .rv-group-title a').first().click();
  await waitFor('the OKF note in the main window', () => evalIn(() => document.querySelector('.rv-note-page .rm-title-display')?.textContent.trim() === 'Heritage Seed Company'), 10000);
  await sleep(500);
  await snap('okf-note', await noteBox());
  await evalIn(() => history.back());
  await sleep(1000);

  // 4f. The section's search box and filter, as Linked References has them.
  await openPage(PAGE);
  await waitFor('External Vault References on the page', async () => (await panelText()).includes('Passata'), 20000);
  await roam.page.locator('.roam-article .rv-panel .rm-mentions-search__search-icon').first().click();
  await roam.page.keyboard.type('bed');
  await waitFor('the search to narrow the section', () => evalIn(() => / of \d+ external vault references$/.test(document.querySelector('.roam-article .rv-panel .rv-sec-head strong')?.textContent ?? '')), 10000);
  await roam.page.mouse.move(5, 5);
  await sleep(800);
  await snap('search', await boxOf('.roam-article .rv-panel', 16));
  await roam.page.locator('.roam-article .rv-panel .rm-mentions-search .bp3-input-action').click();
  await sleep(800);
  await roam.page.locator('.roam-article .rv-panel .bp3-icon-filter').first().click();
  const pop = '.bp3-portal[data-roam-vaults] .bp3-popover';
  await waitFor('the filter', () => evalIn((pop) => !!document.querySelector(`${pop} .rm-filter-button`), pop), 10000);
  await sleep(500);
  {
    const head = await boxOf('.roam-article .rv-panel .rv-sec-head', 16), p = await boxOf(pop, 16);
    const x = Math.min(head.x, p.x), y = Math.min(head.y, p.y);
    await snap('filter', { x, y, width: Math.max(head.x + head.width, p.x + p.width) - x, height: Math.max(head.y + head.height, p.y + p.height) - y });
  }
  await roam.page.locator(`${pop} .rm-filter-button button`, { hasText: 'Blight' }).first().click();
  await roam.page.keyboard.press('Escape');
  await waitFor('the filter to narrow the section', () => evalIn(() => / of \d+ external vault references$/.test(document.querySelector('.roam-article .rv-panel .rv-sec-head strong')?.textContent ?? '')), 10000);
  await roam.page.mouse.move(5, 5);
  await sleep(800);
  await snap('filtered', await boxOf('.roam-article .rv-panel', 16));
  // take it off again
  await roam.page.locator('.roam-article .rv-panel .bp3-icon-filter').first().click();
  await waitFor('the filter', () => evalIn((pop) => !!document.querySelector(`${pop} .rm-choose-filter__includes .rm-filter-button`), pop), 10000);
  await roam.page.locator(`${pop} .rm-choose-filter__includes .rm-filter-button button`).first().click();
  await roam.page.keyboard.press('Escape');
  await sleep(500);

  // 5. A page no note is: a note with a similar name, the letter that differs marked.
  await openPage(SIMILAR_PAGE);
  await waitFor('the note with a similar name', () => evalIn(() => !!document.querySelector('.roam-article .rv-panel .rv-fuzzy .rm-highlight')), 20000);
  await sleep(500);
  await snap('similar-name', await pageBox());

  // 6. The counts under the page title, which are off until their switch is turned on. Turned off
  //    again whatever happens: the setting syncs through the graph, to every run after this one.
  await setSwitch('Reference counts', true);
  try {
    await openPage(PAGE);
    await waitFor('the three counts under the title', () => evalIn(() => document.querySelectorAll('.roam-article .rm-title-display-container + .rv-counts strong').length === 3), 20000);
    await sleep(500);
    const article = await boxOf('.roam-article'), title = await boxOf('.roam-article .rm-title-display'), refs = await boxOf('.roam-article .rm-reference-main');
    const y = Math.max(0, title.y - 24);
    await snap('reference-counts', { x: article.x, y, width: article.width, height: refs.y - 16 - y }); // the title, the counts and the page's own blocks
  } finally {
    await setSwitch('Reference counts', false);
  }

  // 7. A scan part way: a larger vault, every file changed, scanned again.
  const big = path.join(WORK, ARCHIVE);
  const gen = genVault(ARCHIVE_NOTES, big);
  await addVault(big);
  await waitFor(`${ARCHIVE} to finish scanning`, async () => (await statusOf(ARCHIVE)) === `${gen.notes} notes`, 180000, 500);
  touchAll(big);
  await clickButton('Rescan');
  const partWay = () => evalIn((name) => {
    const row = [...document.querySelectorAll('.rv-settings-row')].find((r) => r.querySelector('.rv-settings-name')?.firstChild?.textContent.trim() === name);
    const pct = parseFloat(row?.querySelector('.bp3-progress-bar')?.firstElementChild?.style.width ?? '');
    return pct >= 35 && pct <= 75;
  }, ARCHIVE);
  await waitFor('the scan to be part way', partWay, 120000, 40);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...(await settingsBox()), scale: 1 } }); // no pause: the bar moves
  fs.writeFileSync(path.join(OUT, 'scan-progress.png'), Buffer.from(data, 'base64'));
  log('saved', 'scan-progress.png');
  await waitFor('the scan to finish', async () => (await statusOf(ARCHIVE)) === `${gen.notes} notes`, 180000, 500);
}

let failure = '';
try { await main(); } catch (e) { failure = e.message.split('\n')[0].replace(EMAIL || '\0', '***'); log('ERROR', failure); await snap('debug-error').catch(() => {}); }
try { if (roam.page && roam.signedIn) await clearExtensionState(); } catch { /* best effort */ }
await killRoam('SIGTERM').catch(() => {});
stopServing();
fs.rmSync(WORK, { recursive: true, force: true });
log(failure ? `FAILED: ${failure}` : 'DONE', '->', OUT);
process.exit(failure ? 1 : 0);
