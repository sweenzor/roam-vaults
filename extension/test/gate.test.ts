// The profiler's "clearly worse than main" rule (test/real-roam/gate.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: a plain script, no types
import { worseThan } from './real-roam/gate.mjs';

// main at 10,000 notes, as measured twice in one run of the Profile workflow with the same build
const main = { scanS: 4.2, scanPeakMB: 118, settledMB: 37.2, workerHeapMB: 13.7, pageMedianMs: 102, pageP95Ms: 149,
  fillMedianMs: 73.7, fillP95Ms: 124, rescanS: 1.5, rescanPeakMB: 90, startPageS: 0.6, startS: 0.6, startPeakMB: 86.9, startSettledMB: 54.9 };
const sameBuild = { ...main, scanS: 4.3, settledMB: 41.3, pageP95Ms: 140, fillP95Ms: 109, rescanPeakMB: 122, startS: 0.2, startPeakMB: 80.2 };

test('two runs of one build are not worse than each other', () => {
  assert.deepEqual(worseThan(main, sameBuild), []);
  assert.deepEqual(worseThan(sameBuild, main), []);
});
test('a number has to be both a multiple of main and well over it', () => {
  assert.deepEqual(worseThan(main, { ...main, startS: 1.8 }), [], 'three times, but only 1.2 s more');
  assert.deepEqual(worseThan(main, { ...main, scanPeakMB: 170 }), [], '52 MB more, but under 1.5 times');
  assert.deepEqual(worseThan(main, { ...main, scanS: 8, rescanPeakMB: 400, workerHeapMB: 20 }), ['scanS', 'workerHeapMB', 'rescanPeakMB']);
});
test('better numbers and numbers a build lacks pass', () => {
  assert.deepEqual(worseThan(main, { ...main, scanS: 2, scanPeakMB: 60, startPageS: undefined, rescanS: null }), []);
  assert.deepEqual(worseThan({ ...main, scanS: null }, { ...main, scanS: 60 }), []);
});
