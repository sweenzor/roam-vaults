// When the profiler (profile.mjs, with GATE=1) calls one build clearly worse than another.
//
// A number fails when it is both this many times the first build's and over it by at least this much.
// Both, because one run's numbers move about: between two runs of one build at 10,000 notes, memory
// peaks differ by up to 35 MB and timings by a few tenths of a second. Keys are profile.mjs's metrics;
// times are in the metric's own unit (s or ms), memory in MB.
export const LIMITS = {
  scanS: [1.5, 2], scanPeakMB: [1.5, 75], settledMB: [1.5, 40], workerHeapMB: [1.3, 5],
  pageMedianMs: [1.5, 75], pageP95Ms: [2, 200], fillMedianMs: [1.5, 75], fillP95Ms: [2, 200],
  rescanS: [1.5, 1.5], rescanPeakMB: [1.5, 75], startPageS: [2, 2], startS: [2, 2],
  startPeakMB: [1.5, 75], startSettledMB: [1.5, 40],
};

/** The metrics of `build` that are clearly worse than `base`'s. One that either lacks is passed over. */
export const worseThan = (base, build) => Object.entries(LIMITS).filter(([k, [times, by]]) => {
  const a = base[k], b = build[k];
  return a != null && b != null && b > a * times && b - a > by;
}).map(([k]) => k);
