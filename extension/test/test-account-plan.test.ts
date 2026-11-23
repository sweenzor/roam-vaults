// The real-Roam checks in CI sign in to a Roam test account (the ROAM_EMAIL / ROAM_PASSWORD secrets).
// It needs a paid plan: without one its local graphs are read-only. Its Believer plan ends on the date
// below (Roam's Billing page). This test fails from a year before that, so there is time to renew it.
// After renewing, put the new end date here.
import test from 'node:test';
import assert from 'node:assert/strict';

const PLAN_ENDS = '2031-11-23';

test('the Roam test account plan has more than a year left', () => {
  const warnFrom = new Date(`${PLAN_ENDS}T00:00:00Z`);
  warnFrom.setUTCFullYear(warnFrom.getUTCFullYear() - 1);
  assert.ok(Date.now() < warnFrom.getTime(),
    `The Roam test account's Believer plan ends on ${PLAN_ENDS}: renew it, then update PLAN_ENDS in this file.`);
});
