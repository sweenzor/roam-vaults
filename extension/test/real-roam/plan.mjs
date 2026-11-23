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

/** Opens Billing from the account menu on the graph list and reads the plan and its end date. Call it
 *  after signing in and before opening a graph: it leaves the window on the Billing page. */
export async function readPlan(page) {
  const base = page.url().split('#')[0];
  await page.goto(`${base}#/app`);
  const t0 = Date.now();
  while (Date.now() - t0 < 60000 && !(await page.evaluate(() => /graphs/i.test(document.body.innerText)).catch(() => false))) await page.waitForTimeout(500);
  await page.waitForTimeout(1500);
  // Billing may open a window of its own: keep its address and open it here instead
  await page.evaluate(() => { window.__planOpened = null; window.open = (u) => { window.__planOpened = String(u); return null; }; });
  await page.locator('text=/@/').first().click({ timeout: 10000 }); // the account, top right
  const item = page.locator('.bp3-popover .bp3-menu-item, .bp3-popover a, .bp3-popover button', { hasText: /^Billing$/ }).first();
  await item.waitFor({ timeout: 10000 });
  await item.click();
  await page.waitForTimeout(3000);
  const opened = await page.evaluate(() => window.__planOpened).catch(() => null);
  if (opened) await page.goto(new URL(opened, base).href);
  const lines = async () => (await page.evaluate(() => document.body.innerText).catch(() => '')).split('\n').map((l) => l.trim()).filter(Boolean);
  let all = [];
  for (let i = 0; i < 60 && !all.includes('Expires'); i++) { await page.waitForTimeout(500); all = await lines(); }
  const after = (label) => { const i = all.indexOf(label); return i >= 0 && !/@/.test(all[i + 1] ?? '') ? all[i + 1] : null; };
  return { plan: after('Plan'), ends: roamDate(after('Expires') ?? ''), how: opened ? 'own window' : 'same window' };
}

/** readPlan + planProblems as one result for a run's check list: { ok, detail }. Never throws. */
export async function checkPlan(page, unitTestFile) {
  try {
    const p = await readPlan(page);
    const problems = planProblems(p, pinnedPlanEnd(unitTestFile));
    return { ok: problems.length === 0, detail: problems.join('; ') || `${p.plan}, ends ${p.ends}` };
  } catch (e) {
    return { ok: false, detail: `Billing page not read: ${e.message.split('\n')[0].replace(/\S*@\S*/g, '…').slice(0, 200)}` };
  }
}
