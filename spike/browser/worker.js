// Module worker: (1) seeds OPFS from a bundle using sync access handles,
// (2) runs the whole pipeline off the main thread and answers queries.
import { walkDir, readAll, buildIndex, opfsVault } from './pipeline.js';

let state = null;
self.onmessage = async ({ data }) => {
  if (data.cmd === 'seed') {
    const dir = await opfsVault(data.name);
    const bundle = await (await fetch(data.url)).json();
    const enc = new TextEncoder();
    const t0 = performance.now();
    const failed = [];
    for (const f of bundle.md) {
      try {
        const parts = f.p.split('/');
        let d = dir;
        for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true });
        const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
        const ah = await fh.createSyncAccessHandle();
        ah.truncate(0); ah.write(enc.encode(f.t), { at: 0 }); ah.close();
      } catch (e) { failed.push(`${f.p}: ${e.name}`); }
    }
    for (const p of bundle.other) {
      try {
        const parts = p.split('/');
        let d = dir;
        for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true });
        await d.getFileHandle(parts[parts.length - 1], { create: true });
      } catch (e) { failed.push(`${p}: ${e.name}`); }
    }
    postMessage({ seededMs: performance.now() - t0, files: bundle.md.length, failedCount: failed.length, failed: failed.slice(0, 10) });
  } else if (data.cmd === 'index') {
    const dir = await opfsVault(data.name);
    const t0 = performance.now();
    const w = await walkDir(dir);
    const t1 = performance.now();
    const texts = await readAll(w.md, 32);
    const t2 = performance.now();
    const b = buildIndex(w.md, texts, w.other);
    state = b;
    postMessage({ walkMs: t1 - t0, readMs: t2 - t1, parseMs: b.parseMs, indexMs: b.indexMs, matcherMs: b.matcherMs, totalMs: performance.now() - t0, files: w.md.length });
  } else if (data.cmd === 'query') {
    const a = state.matcher.associations(data.title);
    postMessage({ id: data.id, notes: a.notes.length, links: a.links.length });
  }
};
