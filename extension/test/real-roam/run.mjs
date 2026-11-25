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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { genVault } from './genvault.mjs';
import {
  roam, log, sleep, evalIn, roamMB, serve, stopServing, launchRoam, killRoam, waitFor, shot, signIn, openGraph, secondRoam, closeSecondRoam,
  dismissDialogs, openPage, openSettings, clickLeaf, loadDevExtension, vaultRows, statusOf, clickButton, addVault,
  clearExtensionState, scanMarked, touchAll, panelText, setSwitch,
} from './roam.mjs';
import { checkPlan } from './plan.mjs';

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;

const GRAPH = process.env.ROAM_GRAPH || 'vault-spike-hosted';
const DIST = path.resolve(process.env.DIST || path.join(import.meta.dirname, '../../dist'));
const OUT = path.resolve(process.env.OUT || 'real-roam-out');
const NOTES = +(process.env.NOTES || 20000);
const TEST_PAGE = 'Vaults CI test';
// A page no note is, with a note whose name has two letters swapped: a similar-name (fuzzy) match.
const FUZZY_PAGE = 'Vaults CI fuzzy check', FUZZY_NOTE = 'Vaults CI fuzzy chekc';
const SMALL = 'CI Vault', BIG = 'Big Vault';
// a vault that is only a folder of Markdown files: no .obsidian, no OKF index
const PLAIN = 'Plain notes', PLAIN_PAGE = 'Vaults CI plain';
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
roam.out = OUT; roam.logDir = WORK; // Roam's own log stays in WORK: it isn't ours to publish

// ---------- results ----------
const checks = [], memRows = [], memLog = [];
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

// ---------- the run ----------
// ---------- counts under the page title ----------
const countOf = (labels, kind) => +((labels ?? []).find((l) => l.includes(`${kind} Reference`))?.match(/^\d+/)?.[0] ?? 0);
/** The counts line under the title: there, in order, and its numbers the ones Roam shows itself. */
async function countsMatchRoam(title, vaultLabel = null) {
  await openPage(title);
  const sel = '.roam-article .rm-title-display-container + .rv-counts';
  // give the unlinked count (an async query) a moment to land
  await sleep(3000);
  const line = await evalIn((sel) => { const l = document.querySelector(sel); return l ? [...l.querySelectorAll('strong')].map((e) => e.textContent) : null; }, sel);
  check(`${title}: counts line under the title`, !!line, JSON.stringify(line));
  if (vaultLabel) await shot('counts-under-title');
  const kinds = (line ?? []).map((l) => (l.match(/(Linked|Unlinked|External Vault) References/) ?? [])[1]);
  const order = ['Linked', 'Unlinked', 'External Vault'];
  check(`${title}: counts read Linked, Unlinked, External`, kinds.every((k, i) => k && (i === 0 || order.indexOf(k) > order.indexOf(kinds[i - 1]))), JSON.stringify(kinds));
  if (vaultLabel) check(`${title}: vault count matches the panel`, line?.includes(vaultLabel));
  const roamLinked = await evalIn(() => +(document.querySelector('.roam-article .rm-reference-container > .flex-h-box strong')?.textContent.match(/^\s*(\d+)/)?.[1] ?? 0));
  check(`${title}: linked count matches Roam's`, countOf(line, 'Linked') === roamLinked, `${countOf(line, 'Linked')} vs ${roamLinked}`);
  // Roam counts unlinked references when the section is opened: open it and compare
  // A real mouse click on its caret opens it (a script click on the header row does nothing)
  const caret = roam.page.locator('.roam-article .rm-unlinked-reference-container > .flex-h-box .rm-caret').first();
  await roam.page.locator('.roam-article .rm-unlinked-reference-container > .flex-h-box').first().hover().catch(() => {});
  await caret.click({ force: true }).catch((e) => log('unlinked caret click failed:', e.message));
  const roamUnlinked = await waitFor('Roam to count unlinked references', () => evalIn(() => {
    const m = document.querySelector('.roam-article .rm-unlinked-reference-container > .flex-h-box strong')?.textContent.match(/^\s*(\d+)/);
    return m ? { n: +m[1] } : false; // Roam writes "0 Unlinked References" when there are none; wrapped, as waitFor takes 0 for "not yet"
  }), 15000).then((r) => r.n, () => null);
  const unlinkedHtml = roamUnlinked === null ? await evalIn(() => document.querySelector('.roam-article .rm-unlinked-reference-container')?.outerHTML.slice(0, 400) ?? 'no unlinked section') : '';
  if (unlinkedHtml) log('unlinked section:', unlinkedHtml);
  check(`${title}: unlinked count matches Roam's`, roamUnlinked !== null && countOf(line, 'Unlinked') === roamUnlinked, `${countOf(line, 'Unlinked')} vs ${roamUnlinked}`);
  if (roamUnlinked !== null) await caret.click({ force: true }).catch(() => {}); // fold it again
  if (vaultLabel) {
    await evalIn((sel) => [...document.querySelectorAll(`${sel} strong`)].find((e) => e.textContent.includes('External'))?.click(), sel);
    await sleep(1500);
    check(`${title}: clicking the vault count jumps to the panel`, await evalIn(() => { const r = document.querySelector('.roam-article .rv-panel')?.getBoundingClientRect(); return !!r && r.top >= 0 && r.top < innerHeight - 40; }));
    await shot('counts-after-jump');
  }
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'extension.js'))) throw new Error(`no build in ${DIST}: run npm run build first`);
  // vaults first, so writing them doesn't disturb the memory numbers
  const small = path.join(WORK, SMALL), big = path.join(WORK, BIG);
  const smallFiles = {
    // long enough to run past the window: the wheel over it unfolded must scroll the page
    [`${TEST_PAGE}.md`]: `# ${TEST_PAGE}\nThe note for this page. See [[CI linked note]].\n${Array.from({ length: 60 }, (_, i) => `- Line ${i + 1} of a long note\n`).join('')}`,
    'Notes/CI linked note.md': `Mentions [[${TEST_PAGE}]] in a backlink line.\n`,
    'Daily/2026-01-02.md': `- met about [[${TEST_PAGE}|the CI page]]\n`,
    [`Notes/${FUZZY_NOTE}.md`]: 'A note whose name has a typo.\n',
    '.obsidian/app.json': '{}',
  };
  for (const [rel, text] of Object.entries(smallFiles)) { fs.mkdirSync(path.dirname(path.join(small, rel)), { recursive: true }); fs.writeFileSync(path.join(small, rel), text); }
  const plain = path.join(WORK, PLAIN);
  const plainFiles = {
    [`${PLAIN_PAGE}.md`]: `A plain Markdown file for this page.\n`,
    // a line with text keeps its children folded; a line that is only the link shows them, as Roam does
    'Garden/Seed list.md': `- sow carrots, see [[${PLAIN_PAGE}]]\n    - rows a foot apart\n- [[${PLAIN_PAGE}]]\n    - seedlings up on day nine\n`,
    'Garden/Beds/North bed.md': `Watered on Monday. Notes in [the plain page](../../${PLAIN_PAGE.replace(/ /g, '%20')}.md).\n`,
  };
  for (const [rel, text] of Object.entries(plainFiles)) { fs.mkdirSync(path.dirname(path.join(plain, rel)), { recursive: true }); fs.writeFileSync(path.join(plain, rel), text); }
  const gen = genVault(NOTES, big);
  log(`generated ${BIG}: ${gen.files} files, ${gen.mb} MB`);

  serve(DIST);
  await launchRoam();
  await signIn(EMAIL, PASSWORD);
  { const plan = await checkPlan(roam.page, GRAPH.startsWith('offline/') ? `#/${GRAPH}` : `#/app/${GRAPH}`); check("The test account's plan is Believer and ends more than a year away", plan.ok, plan.detail); }
  await openGraph(GRAPH);
  await clearExtensionState();
  await openPage(TEST_PAGE);
  await sleep(5000);
  baseline = (await sample('baseline-no-extension', 20000, 5000)).mean;
  memRows.push({ step: `Roam without the extension (absolute)`, mb: Math.round(baseline) });

  // load through Roam Depot developer mode
  await loadDevExtension();
  check('Extension loads through Roam Depot developer mode', true);
  // The folder picker's hang guard (src/main/picker.ts) is on only where this is true.
  check('Roam desktop is recognised as the desktop app', await evalIn(() => /\bElectron\//.test(navigator.userAgent) || window.roamAlphaAPI?.platform?.isDesktop === true), await evalIn(() => `${navigator.userAgent} isDesktop=${window.roamAlphaAPI?.platform?.isDesktop}`));
  await openPage(TEST_PAGE);
  await sleep(2000);
  check('Nothing on the page before a vault is added', (await panelText()).trim() === '');

  // small vault: function
  await addVault(small);
  await waitFor(`${SMALL} to finish scanning`, async () => /^4 notes$/.test(await statusOf(SMALL)), 30000)
    .catch(async (e) => { check('Small vault scans', false, await statusOf(SMALL)); throw e; });
  check('Vault list shows the new vault and its note count', true, '4 notes');
  await shot('settings-one-vault');
  await openPage(TEST_PAGE);
  const t1 = await waitFor('External Vault References on the page', async () => { const t = await panelText(); return t.includes('External Vault References') && t; }, 15000).catch(() => '');
  check('External Vault References shows on a real Roam page', t1.includes('3 External Vault References'), t1.split('\n')[0]);
  check('Counterpart note listed first', (await evalIn(() => document.querySelector('.roam-article .rv-panel .rv-note')?.textContent.trim()))?.endsWith(TEST_PAGE)); // "CI Vault/…" once there are two vaults
  check('Backlink line shown', t1.includes('Mentions') && t1.includes('backlink line'));
  check('Panel sits below Linked References', await evalIn(() => {
    const refs = document.querySelector('.roam-article .rm-reference-main'), panel = document.querySelector('.roam-article .rv-panel');
    return !!refs && !!panel && !!(refs.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));
  await roam.page.locator('.roam-article .rv-group-caret').first().click().catch(() => {});
  const unfolded = await waitFor('the counterpart note to unfold', () => evalIn(() => document.querySelector('.roam-article .rv-preview')?.innerText.includes('The note for this page')), 5000).catch(() => false);
  check('Unfolding a note shows it inline', unfolded);
  { // the wheel over the unfolded note scrolls the page, as over Roam's own references
    const box = roam.page.locator('.roam-article .rv-preview').first();
    const state = () => box.evaluate((el) => {
      let s = el.parentElement; while (s && !/(auto|scroll)/.test(getComputedStyle(s).overflowY)) s = s.parentElement;
      return { page: s?.scrollTop ?? -1, box: el.scrollTop, own: /(auto|scroll)/.test(getComputedStyle(el).overflowY) };
    }).catch(() => null);
    await box.evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
    await sleep(300);
    const before = await state(), r = await box.boundingBox().catch(() => null);
    if (r) { await roam.page.mouse.move(r.x + r.width / 2, r.y + Math.min(200, r.height / 2)); await roam.page.mouse.wheel(0, 400); }
    await sleep(800);
    const after = await state();
    check('A long note unfolded has no scroll of its own', after && !after.own && after.box === 0, JSON.stringify(after));
    check('The wheel over an unfolded note scrolls the page', before && after && after.page > before.page, `${before?.page} -> ${after?.page}`);
    await shot('long-note-wheel');
    await box.evaluate((el) => el.closest('.rv-panel')?.scrollIntoView({ block: 'start' })).catch(() => {});
  }
  await shot('page-external-vault-references');
  // the counts line is off until the Reference counts switch is turned on
  check('Reference counts switch turns off (an earlier run may have left it on)', (await setSwitch('Reference counts', false)) === false);
  await openPage(TEST_PAGE);
  await sleep(3000);
  check('No counts line while Reference counts is off', await evalIn(() => !document.querySelector('.rv-counts')));
  await shot('counts-off');
  check('Reference counts switch turns on', (await setSwitch('Reference counts', true)) === true);
  await countsMatchRoam(TEST_PAGE, '3 External Vault References');
  // a page of the test graph with references of its own, when it has one
  if (await evalIn((t) => !!window.roamAlphaAPI.q('[:find ?p . :in $ ?t :where [?p :node/title ?t]]', t), 'Kernel meeting protocol')) await countsMatchRoam('Kernel meeting protocol');
  // settings sync through the graph, so leave the switch off for the next run
  check('Reference counts switch turns off again', (await setSwitch('Reference counts', false)) === false);
  await openPage(TEST_PAGE);
  await sleep(2000);
  check('Turning Reference counts off removes the line', await evalIn(() => !document.querySelector('.rv-counts')));
  // similar names: only on a page no note is, faded, the swapped letters highlighted
  await openPage(FUZZY_PAGE);
  const fz = await waitFor('a similar-name match', () => evalIn(() => {
    const row = document.querySelector('.roam-article .rv-panel .rv-fuzzy');
    return row && { title: row.querySelector('.rv-note')?.textContent.trim(), marked: [...row.querySelectorAll('.rv-note .rm-highlight')].map((e) => e.textContent).join(',') };
  }), 15000).catch(() => null);
  check('A note with a similar name shows, faded, on a page no note is', fz?.title?.endsWith(FUZZY_NOTE), fz?.title ?? 'none');
  check('The letters that differ are highlighted', fz?.marked === 'kc', fz?.marked ?? '');
  await shot('page-similar-name');
  await openPage(TEST_PAGE);
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

  // a note opened in the main window, then left by every way to a place: Roam keeps a component in
  // its main window until it goes somewhere else, and does nothing when asked for the place it is on
  const where = () => evalIn(async () => { const v = await window.roamAlphaAPI.ui.mainWindow.getOpenView(); return v.type === 'custom' ? 'note' : v.type === 'log' ? 'Daily Notes' : document.querySelector('.roam-article .rm-title-display')?.textContent.trim(); });
  const reach = (want, ms = 8000) => waitFor(want, async () => (await where()) === want, ms).then(() => sleep(800)).then(where, where);
  const lineBullet = (text, scope = '.roam-article') => roam.page.locator(`${scope} .rv-panel .rm-reference-item`, { hasText: text }).locator('.rm-bullet').first().click();
  await openPage(TEST_PAGE);
  await lineBullet('backlink line');
  check('A click on a line\'s bullet opens its note in the main window', await reach('note') === 'note');
  await shot('note-in-main-window');
  await evalIn((t) => window.roamAlphaAPI.ui.mainWindow.openPage({ page: { title: t } }), TEST_PAGE);
  check('Asking for the page the note was opened from shows that page', await reach(TEST_PAGE) === TEST_PAGE);
  await roam.page.goForward();
  check('Forward shows the note again', await reach('note') === 'note');
  await roam.page.locator('.rm-left-sidebar__daily-notes').dispatchEvent('click');
  check('Daily Notes in the left sidebar leaves the note', await reach('Daily Notes') === 'Daily Notes');
  await roam.page.goBack();
  check('Back comes back to the note, and stays', await reach('note') === 'note' && (await sleep(2000), await where()) === 'note');
  await roam.page.goBack();
  check('Back again shows the page the note was opened from', await reach(TEST_PAGE) === TEST_PAGE);
  // from the Daily Notes, as another extension's buttons go there (Yesterday & Tomorrow calls
  // openDailyNotes for the Daily Notes and openBlock for a day)
  const today = await evalIn(() => window.roamAlphaAPI.util.dateToPageTitle(new Date()));
  const daybook = path.join(small, 'Daybook.md');
  fs.writeFileSync(daybook, `- Starter fed at dawn, [[${today}]]\n`);
  await evalIn(() => window.roamAlphaAPI.ui.mainWindow.openDailyNotes());
  const onLog = await waitFor('the note on the Daily Notes', () => evalIn(() => !!document.querySelector('.roam-log-container .rv-panel .rm-reference-item')), 20000).then(() => true, () => false);
  if (onLog) {
    await lineBullet('Starter fed at dawn', '.roam-log-container');
    check('A note opens from the Daily Notes', await reach('note') === 'note');
    await roam.page.locator('.rm-left-sidebar__daily-notes').dispatchEvent('click');
    check('Daily Notes in the left sidebar shows the Daily Notes it was opened from', await reach('Daily Notes') === 'Daily Notes');
    await roam.page.goForward();
    check('Forward shows the note again', await reach('note') === 'note');
    await evalIn(() => window.roamAlphaAPI.ui.mainWindow.openDailyNotes());
    check('openDailyNotes shows the Daily Notes', await reach('Daily Notes') === 'Daily Notes');
    await evalIn(() => window.roamAlphaAPI.ui.mainWindow.openBlock({ block: { uid: window.roamAlphaAPI.util.dateToPageUid(new Date()) } }));
    await reach(today);
    await lineBullet('Starter fed at dawn');
    check("A note opens from today's page", await reach('note') === 'note');
    await evalIn(() => window.roamAlphaAPI.ui.mainWindow.openBlock({ block: { uid: window.roamAlphaAPI.util.dateToPageUid(new Date()) } }));
    check("openBlock of today shows today's page", await reach(today) === today);
  } else check('A note linking today shows on the Daily Notes', false);
  fs.rmSync(daybook);
  await openPage(TEST_PAGE);
  await waitFor('the page\'s vault references again', async () => /\d+ External Vault References/.test(await panelText()), 20000).catch(() => {});

  // a folder named like the page: its notes are listed like any note, added and removed while Roam is open
  const folder = path.join(small, 'Projects', TEST_PAGE);
  const before = Number((await panelText()).match(/(\d+) External Vault References/)?.[1] ?? 0);
  fs.mkdirSync(path.join(folder, 'Files'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'Plan.md'), 'The plan kept in the folder, with no link back.\n');
  fs.writeFileSync(path.join(folder, 'Files', 'Budget.md'), 'A note one folder further in.\n');
  fs.writeFileSync(path.join(folder, 'Files', 'spec.pdf'), '%PDF-1.4\n');
  const folderRows = () => evalIn((dir) => [...document.querySelectorAll('.roam-article .rv-panel .rv-group')]
    .map((g) => ({ title: g.querySelector('.rv-note')?.textContent.trim() ?? '', folded: g.querySelector('.rv-content')?.hidden, grey: [...g.querySelectorAll('.rv-note .rv-vault')].map((x) => x.textContent).join('') }))
    .filter((r) => r.title.includes(dir)), `Projects/${TEST_PAGE}/`);
  const listed = await waitFor('the folder\'s notes to be listed', async () => { const r = await folderRows(); return r.length === 2 && r; }, 20000).catch(() => null);
  check('Notes in a folder named like the page are listed, without a Rescan, the nearest first',
    JSON.stringify(listed?.map((r) => r.title.slice(r.title.indexOf('Projects/')))) === JSON.stringify([`Projects/${TEST_PAGE}/Plan`, `Projects/${TEST_PAGE}/Files/Budget`]), JSON.stringify(listed ?? await folderRows()));
  check('They are folded, and the other file in the folder is not listed', !!listed?.every((r) => r.folded === true) && !(await panelText()).includes('spec.pdf'));
  check('The path above the folder is grey', !!listed?.every((r) => r.grey.endsWith('Projects/')), JSON.stringify(listed?.map((r) => r.grey)));
  const tHead = await panelText();
  check('Each counts as an External Vault Reference', tHead.includes(`${before + 2} External Vault References`), tHead.split('\n')[0]);
  check('Nothing is drawn for the folder itself', await evalIn(() => !document.querySelector('.rv-panel .rv-file, .rv-panel .rv-count, .rv-panel .rv-files')));
  await shot('page-folder-notes');
  await roam.page.locator('.roam-article .rv-panel .rv-note', { hasText: `Projects/${TEST_PAGE}/Plan` }).first().click({ modifiers: ['Shift'] }).catch(() => {});
  const viewed = await waitFor('the note viewer', () => evalIn(() => { const v = document.querySelector('.rv-viewer'); return v && v.innerText.includes('The plan kept in the folder') && v.querySelector('h3')?.textContent.trim(); }), 8000).catch(() => null);
  check('A note in the folder opens over the page with a shift-click', viewed === 'Plan', String(viewed));
  await shot('page-folder-note-viewer');
  await roam.page.keyboard.press('Escape');
  await sleep(500);
  fs.rmSync(path.join(small, 'Projects'), { recursive: true });
  const gone = await waitFor('the folder\'s notes to go', async () => !(await folderRows()).length, 20000).then(() => true, () => false);
  check('Removing the folder on disk removes its notes', gone, JSON.stringify(await folderRows()));

  // plain vault: a folder of Markdown files and nothing else still works
  await addVault(plain);
  const plainScanned = await waitFor(`${PLAIN} to finish scanning`, async () => /^3 notes$/.test(await statusOf(PLAIN)), 30000).then(() => true, () => false);
  check('A plain folder of Markdown files (no .obsidian) scans', plainScanned, await statusOf(PLAIN));
  await openPage(PLAIN_PAGE);
  const tp = await waitFor('External Vault References on the plain page', async () => { const t = await panelText(); return t.includes('External Vault References') && t; }, 15000).catch(() => '');
  check('Plain vault: its notes show as External Vault References', tp.includes('3 External Vault References'), tp.split('\n')[0]);
  check('Plain vault: the note named like the page is listed first', (await evalIn(() => document.querySelector('.roam-article .rv-panel .rv-note')?.textContent.trim()))?.endsWith(PLAIN_PAGE));
  check('Plain vault: a [[wikilink]] line from a nested folder shows', tp.includes('sow carrots'));
  check('Plain vault: a relative Markdown link two folders down shows', tp.includes('Watered on Monday'));
  check('Plain vault: a line that is only the link shows its children, as in Roam', tp.includes('seedlings up on day nine'));
  check('Plain vault: a line with more than the link keeps its children folded, as in Roam', tp.includes('sow carrots') && !tp.includes('rows a foot apart'));
  await shot('page-plain-vault');

  // large vault: memory
  await addVault(big);
  const cold = sample('cold-scan', 90000, 60000);
  const scanned = await waitFor(`${BIG} to finish scanning`, async () => (await statusOf(BIG)) === `${gen.notes} notes`, 85000).then(() => true, () => false);
  const coldM = await cold;
  check(`Large vault scans (${NOTES.toLocaleString('en-US')} notes)`, scanned, await statusOf(BIG));
  memRow('First scan, peak', coldM.peak, LIMITS.coldPeak);
  memRow('Settled 60-90 s after adding the vault', coldM.mean, LIMITS.settled);
  await shot('settings-large-vault');

  const rescan = async (label, limit, clicks = 1) => {
    const s = sample(label, 60000);
    for (let i = 0; i < clicks; i++) await clickButton('Rescan');
    await sleep(3000);
    const done = await waitFor(`${label} to finish`, async () => (await statusOf(BIG)) === `${gen.notes} notes`, 55000).then(() => true, () => false);
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
    for (let i = 0; i < 8; i++) { if ((await statusOf(BIG)) !== `${gen.notes} notes` || await hasMark()) return false; await sleep(250); }
    return true;
  }, 90000).catch(() => {});
  log(`before reload: ${BIG} "${await statusOf(BIG)}", mark ${await hasMark()}`);
  // Chromium writes localStorage to disk up to about 5 s after a change, so a mark set less than
  // that before a crash is lost. Make the vault six times the size so the startup scan runs well
  // past that: a scan reads about 5,000 changed notes a second on a GitHub runner.
  const extra = genVault(NOTES * 5, path.join(big, 'Extra'));
  log(`added ${extra.files} more files so the scan runs longer`);
  touchAll(big);
  await dismissDialogs();
  await roam.page.reload();
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
  await signIn(EMAIL, PASSWORD);
  await openGraph(GRAPH);
  await waitFor('the extension to load after relaunch', async () => { await openSettings(); return clickLeaf('Vaults (dev)'); }, 60000);
  await waitFor('the vault list', () => evalIn(() => !!document.querySelector('.rv-settings')), 10000);
  const rows = await waitFor('both vault rows', async () => { const r = await vaultRows(); return r[BIG] && r[SMALL] && /notes?$/.test(r[SMALL].status) && r; }, 30000).catch(() => null);
  check('After a crash mid-scan the vault reads "Last scan didn\'t finish"', rows?.[BIG]?.status === "Last scan didn't finish", rows?.[BIG]?.status);
  check('…with its own Rescan button', rows?.[BIG]?.buttons.includes('Rescan'));
  check('The other vault scans normally after the crash', rows?.[SMALL]?.status === '5 notes', rows?.[SMALL]?.status);
  await shot('after-crash-last-scan-didnt-finish');
  await clickButton('Rescan', BIG);
  // The bar is Roam's own (Blueprint's): the extension only gives it a margin, so Roam's CSS has to draw it.
  const barOf = (partWay) => evalIn(([name, partWay]) => {
    const row = [...document.querySelectorAll('.rv-settings-row')].find((r) => r.querySelector('.rv-settings-name')?.firstChild?.textContent.trim() === name);
    const bar = row?.querySelector('.bp3-progress-bar'), meter = bar?.firstElementChild;
    if (!meter || (partWay && !/^[1-9]\d?%$/.test(meter.style.width))) return null;
    return { height: bar.getBoundingClientRect().height, width: Math.round(bar.getBoundingClientRect().width), meter: meter.style.width, placed: getComputedStyle(meter).position };
  }, [BIG, partWay]);
  const bar = await waitFor('the progress bar part way', () => barOf(true), 60000, 50).catch(() => waitFor('the progress bar', () => barOf(false), 5000, 50).catch(() => null));
  await shot('scan-progress-bar');
  check("A scan shows Roam's progress bar in the vault's row, part way along", bar?.height === 8 && bar.width > 100 && bar.placed === 'absolute' && bar.meter !== '100%', JSON.stringify(bar));
  const recovered = await waitFor('the row Rescan to finish', async () => (await statusOf(BIG)) === `${gen.notes + extra.notes} notes`, 150000).then(() => true, () => false);
  check("The row's Rescan scans the vault and clears the mark", recovered && !(await scanMarked(BIG)), await statusOf(BIG));
  await shot('after-row-rescan');

  // Roam open a second time on the same graph, as in a second tab: it shows the vaults from the
  // first one's index. Last, so that it adds nothing to the memory measured above.
  await dismissDialogs();
  await openPage(TEST_PAGE);
  await waitFor('External Vault References on the page', async () => (await panelText()).includes('backlink line'), 20000).catch(() => {});
  const second = await secondRoam();
  if (!second) log('second Roam: it did not load in a frame, so sharing a vault between two of them was not checked here');
  else {
    const text2 = () => second.evaluate(() => document.querySelector('.roam-article .rv-panel')?.innerText ?? '').catch(() => '');
    const shows = await waitFor('the vault panel in the second Roam', async () => (await text2()).includes('backlink line'), 90000, 500).then(() => true, () => false);
    check("Roam open a second time on the graph shows the vaults' notes", shows, (await text2()).split('\n')[0]);
    const locks = await evalIn(async () => {
      const l = await navigator.locks.query(), ours = (x) => x.name.startsWith('roam-vaults:');
      return `${l.held.filter(ours).length} vaults open, ${l.pending.filter(ours).length} waited for`;
    }).catch((e) => e.message);
    check("…from the first one's index, without opening the vaults again", locks === '3 vaults open, 3 waited for', locks);
    fs.writeFileSync(path.join(small, 'Two windows note.md'), `Written with Roam open twice, links [[${TEST_PAGE}]].\n`);
    const both = await waitFor('the new note in both', async () => (await panelText()).includes('Two windows note') && (await text2()).includes('Two windows note'), 20000).then(() => true, () => false);
    check('A note added on disk shows up in both', both);
    await closeSecondRoam();
  }
}

let stopped = '';
try { await main(); }
catch (e) { stopped = e.message.replace(EMAIL || '\0', '***'); log('ERROR', stopped); await shot('error'); }
finally {
  const pass = writeResults(stopped);
  log(fs.readFileSync(path.join(OUT, 'RESULTS.md'), 'utf8'));
  await killRoam('SIGTERM').catch(() => {});
  stopServing();
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}
