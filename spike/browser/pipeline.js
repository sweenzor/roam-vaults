// Shared browser pipeline: walk a FileSystemDirectoryHandle, read .md files,
// parse + index. Used by both the page (main thread) and the worker.
import { parseNote } from '../build/core/parser.js';
import { VaultIndex } from '../build/core/vault-index.js';
import { RoamMatcher } from '../build/core/matcher.js';

export async function walkDir(dir, prefix = '', out = { md: [], other: [] }) {
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (h.kind === 'directory') await walkDir(h, rel, out);
    else if (/\.md$/i.test(name)) out.md.push({ rel: rel.normalize('NFC'), h });
    else out.other.push(rel.normalize('NFC'));
  }
  return out;
}

export async function readAll(files, conc) {
  const texts = new Array(files.length);
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < files.length) { const k = i++; texts[k] = await (await files[k].h.getFile()).text(); }
  }));
  return texts;
}

export function buildIndex(files, texts, other) {
  const t0 = performance.now();
  const notes = files.map((f, k) => parseNote(f.rel, texts[k]));
  const t1 = performance.now();
  const idx = new VaultIndex();
  idx.build(notes, other);
  const t2 = performance.now();
  const matcher = new RoamMatcher(idx, { dailyFormats: ['YYYY-MM-DD'] });
  const t3 = performance.now();
  return { idx, matcher, parseMs: t1 - t0, indexMs: t2 - t1, matcherMs: t3 - t2 };
}

export async function opfsVault(name) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}
