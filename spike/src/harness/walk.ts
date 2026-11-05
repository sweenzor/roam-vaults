// Node-only: directory walking + file reading (the part a browser replaces with
// the File System Access API / Electron IPC).
import fs from 'node:fs';
import path from 'node:path';

export interface WalkResult { md: { rel: string; abs: string; rawName: string }[]; other: string[]; skippedDirs: number }

/** Obsidian ignores dot-folders (.obsidian, .git, .trash). */
export function walk(root: string): WalkResult {
  const res: WalkResult = { md: [], other: [], skippedDirs: 0 };
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (d.name.startsWith('.')) { if (d.isDirectory()) res.skippedDirs++; continue; }
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) stack.push(r);
      else if (d.isFile()) {
        if (/\.md$/i.test(d.name)) res.md.push({ rel: r.normalize('NFC'), abs: path.join(root, r), rawName: r });
        else res.other.push(r.normalize('NFC'));
      }
    }
  }
  return res;
}

export function readAllSync(files: { rel: string; abs: string }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of files) m.set(f.rel, fs.readFileSync(f.abs, 'utf8'));
  return m;
}

export async function readAllAsync(files: { rel: string; abs: string }[], conc = 32): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < files.length) { const f = files[i++]; m.set(f.rel, await fs.promises.readFile(f.abs, 'utf8')); }
  }));
  return m;
}
