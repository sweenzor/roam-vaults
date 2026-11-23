// The Roam test account's plan, read live from Roam's Billing page. Real-Roam CI signs in to that
// account; without a paid plan its local graphs are read-only. The end date is also pinned in the unit
// test named below (PLAN_ENDS), which fails a year before it even when no real-Roam run happens.
//
// Nothing about the account is logged: only the plan's name and its end date are read off the page.
import fs from 'node:fs';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** PLAN_ENDS ('YYYY-MM-DD') from the unit test `file`. */
export function pinnedPlanEnd(file) {
  return fs.readFileSync(file, 'utf8').match(/PLAN_ENDS = '(\d{4}-\d{2}-\d{2})'/)?.[1] ?? null;
}

/** "November 23rd, 2031" -> "2031-11-23". */
export function roamDate(text) {
  const m = String(text).match(/([A-Z][a-z]+) (\d{1,2})(?:st|nd|rd|th)?, (\d{4})/);
  const month = m ? MONTHS.indexOf(m[1]) + 1 : 0;
  return month ? `${m[3]}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

/** What is wrong with `plan` ({ plan, ends }): not Believer, ends within a year, or not the pinned date. */
export function planProblems({ plan, ends }, pinned, now = Date.now()) {
  const problems = [];
  if (plan !== 'Believer') problems.push(`plan is ${plan ? `"${plan}"` : 'not shown'}, not Believer`);
  if (!ends) problems.push('no end date shown');
  else {
    const warnFrom = new Date(`${ends}T00:00:00Z`);
    warnFrom.setUTCFullYear(warnFrom.getUTCFullYear() - 1);
    if (now >= warnFrom.getTime()) problems.push(`plan ends on ${ends}, less than a year away: renew it`);
    if (pinned && ends !== pinned) problems.push(`plan ends on ${ends} but the unit test pins ${pinned}: update PLAN_ENDS there`);
  }
  return problems;
}

const clean = (s) => String(s ?? '').replace(/\S*@\S*/g, '…');

/** Opens Billing and reads the plan and its end date. Call it after signing in and before opening a
 *  graph: it leaves the window on the graph list. Tries the account menu on the graph list, then
 *  Settings > Account > Open Billing in a graph (`graph`, a hash like '#/app/name'). Billing may open in
 *  this window, in a window of its own, or by window.open; all three are followed. `notes` collects
 *  what each step saw (never anything with an @). */
export async function readPlan(page, graph = null, notes = []) {
  const base = page.url().split('#')[0];
  const ctx = page.context();
  const text = async (p) => (await p.evaluate(() => document.body.innerText).catch(() => '')).split('\n').map((l) => l.trim()).filter(Boolean);
  const read = (all) => {
    const after = (label) => { const i = all.indexOf(label); return i >= 0 && !/@/.test(all[i + 1] ?? '') ? all[i + 1] : null; };
    return { plan: after('Plan'), ends: roamDate(after('Expires') ?? '') };
  };
  const capture = () => page.evaluate(() => { window.__planOpened = null; window.__planOpen ??= window.open; window.open = (u) => { window.__planOpened = String(u); return null; }; }).catch(() => {});
  // after a click on Billing: wherever it went, wait there for "Expires"
  const follow = async (pagesBefore, urlBefore) => {
    await page.waitForTimeout(2000);
    const opened = await page.evaluate(() => window.__planOpened).catch(() => null);
    const newPage = ctx.pages().find((p) => !pagesBefore.includes(p));
    let p = page;
    if (newPage) { p = newPage; await p.waitForLoadState('domcontentloaded').catch(() => {}); }
    else if (opened) await page.goto(new URL(opened, base).href);
    notes.push(`after the click: ${newPage ? 'a window of its own' : opened ? 'window.open' : page.url() !== urlBefore ? 'this window moved' : 'nothing moved'} (${clean(new URL(p.url()).hash || new URL(p.url()).pathname)})`);
    let all = [];
    for (let i = 0; i < 40 && !all.includes('Expires'); i++) { await p.waitForTimeout(500); all = await text(p); }
    if (p !== page) await p.close().catch(() => {});
    return all;
  };
  const clickBilling = (re) => page.evaluate((src) => {
    const re = new RegExp(src);
    const el = [...document.querySelectorAll('body *')].find((e) => e.children.length === 0 && re.test(e.textContent.trim()) && e.offsetParent);
    const target = el?.closest('a, button, li, .bp3-menu-item') ?? el;
    if (target) target.click();
    return target ? `${target.tagName.toLowerCase()}${target.getAttribute('href') ? ` href ${target.getAttribute('href')}` : ''}` : null;
  }, re.source);
  const menuItems = () => page.evaluate(() => [...document.querySelectorAll('.bp3-popover *, .bp3-menu *')].filter((e) => e.children.length === 0 && e.textContent.trim() && !/@/.test(e.textContent)).map((e) => e.textContent.trim()).slice(0, 12).join('/')).catch(() => '');

  // 1. the account menu, top right of the graph list
  await page.goto(`${base}#/app`);
  const t0 = Date.now();
  while (Date.now() - t0 < 60000 && !(await page.evaluate(() => /graphs/i.test(document.body.innerText)).catch(() => false))) await page.waitForTimeout(500);
  await page.waitForTimeout(1500);
  await capture();
  const who = page.locator('text=/@/').first();
  const box = await who.boundingBox().catch(() => null);
  await who.click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
  let items = await menuItems();
  if (!/Billing/.test(items) && box) { await page.mouse.click(box.x + box.width + 28, box.y + box.height / 2); await page.waitForTimeout(800); items = await menuItems(); }
  notes.push(`account menu: ${items || 'did not open'}`);
  if (/Billing/.test(items)) {
    const pages = ctx.pages(), url = page.url();
    notes.push(`clicked ${clean(await clickBilling(/^Billing$/))}`);
    const got = read(await follow(pages, url));
    if (got.plan || got.ends) return { ...got, how: 'account menu' };
  }
  await page.keyboard.press('Escape').catch(() => {});

  // 2. Settings > Account > Open Billing, in a graph
  if (graph) {
    await page.goto(`${base}${graph}`);
    for (let i = 0; i < 120 && !(await page.evaluate(() => !!window.roamAlphaAPI?.data?.q && !!document.querySelector('.roam-main')).catch(() => false)); i++) await page.waitForTimeout(500);
    await page.waitForTimeout(1500);
    await capture();
    // the More menu, top right, then Settings (as roam.mjs openSettings does)
    const more = page.locator('.rm-topbar .bp3-icon-more').first();
    if (await more.count()) await more.click({ timeout: 5000 }).catch(() => {}); else await page.mouse.click(1088, 22);
    await page.waitForTimeout(800);
    await page.evaluate(() => [...document.querySelectorAll('.bp3-menu-item')].find((e) => /^Settings/.test(e.innerText.trim()))?.click()).catch(() => {});
    await page.waitForTimeout(1500);
    await page.evaluate(() => [...document.querySelectorAll('.bp3-dialog .bp3-tab, .bp3-dialog [role="tab"]')].find((e) => e.textContent.trim() === 'Account')?.click()).catch(() => {});
    await page.waitForTimeout(1000);
    const pages = ctx.pages(), url = page.url();
    notes.push(`settings: clicked ${clean(await clickBilling(/^Open Billing$/))}`);
    const all = await follow(pages, url);
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => { if (window.__planOpen) window.open = window.__planOpen; }).catch(() => {});
    const got = read(all);
    if (got.plan || got.ends) return { ...got, how: 'settings' };
  }
  return { plan: null, ends: null, how: 'not found' };
}

/** readPlan + planProblems as one result for a run's check list: { ok, detail }. Never throws. */
export async function checkPlan(page, unitTestFile, graph = null) {
  const notes = [];
  try {
    const p = await readPlan(page, graph, notes);
    const problems = planProblems(p, pinnedPlanEnd(unitTestFile));
    return { ok: problems.length === 0, detail: clean(problems.length ? `${problems.join('; ')} [${notes.join('; ')}]` : `${p.plan}, ends ${p.ends}, read from ${p.how}`).slice(0, 600) };
  } catch (e) {
    return { ok: false, detail: clean(`Billing page not read: ${e.message.split('\n')[0]} [${notes.join('; ')}]`).slice(0, 600) };
  }
}
