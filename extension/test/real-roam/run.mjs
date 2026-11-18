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
  roam, log, sleep, evalIn, roamMB, serve, stopServing, launchRoam, killRoam, waitFor, shot, signIn, openGraph,
  dismissDialogs, openPage, openSettings, clickLeaf, loadDevExtension, vaultRows, statusOf, clickButton, addVault,
  clearExtensionState, scanMarked, touchAll, panelText,
} from './roam.mjs';

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;

const GRAPH = process.env.ROAM_GRAPH || 'vault-spike-hosted';
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

  serve(DIST);
  await launchRoam();
  await signIn(EMAIL, PASSWORD);
  await openGraph(GRAPH);
  await clearExtensionState();
  await openPage(TEST_PAGE);
  await sleep(5000);
  baseline = (await sample('baseline-no-extension', 20000, 5000)).mean;
  memRows.push({ step: `Roam without the extension (absolute)`, mb: Math.round(baseline) });

  // load through Roam Depot developer mode
  await loadDevExtension();
  check('Extension loads through Roam Depot developer mode', true);
  await openPage(TEST_PAGE);
  await sleep(2000);
  check('Nothing on the page before a vault is added', (await panelText()).trim() === '');

  // small vault: function
  await addVault(small);
  await waitFor(`${SMALL} to finish scanning`, async () => /^3 notes$/.test(await statusOf(SMALL)), 30000)
    .catch(async (e) => { check('Small vault scans', false, await statusOf(SMALL)); throw e; });
  check('Vault list shows the new vault and its note count', true, '3 notes');
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
  await shot('page-external-vault-references');
  fs.writeFileSync(path.join(small, 'Fresh CI note.md'), `Written while Roam was open, links [[${TEST_PAGE}]].\n`);
  const live = await waitFor('the new note to appear', async () => (await panelText()).includes('Fresh CI note'), 15000).then(() => true, () => false);
  check('A note added on disk shows up without a Rescan', live);

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
  check('The other vault scans normally after the crash', rows?.[SMALL]?.status === '4 notes', rows?.[SMALL]?.status);
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
