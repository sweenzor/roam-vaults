// Synthesizes a realistic Roam page-title list against a given vault index.
// Pure (no Node APIs) so the browser bench can reuse it.
import type { VaultIndex } from '../core/vault-index.ts';
import { isoToRoamDaily } from '../core/dates.ts';

export const FIXED_TITLES = [
  'What is X?', 'A: B', 'Projects/Alpha', 'Projects/Beta/Gamma', 'TODO', 'DONE', 'Q&A', 'C#', 'Node.js', '[[Roam]] Tips',
  'Meeting with [[Alice]]', '1/2 cup', 'Café'.normalize('NFD'), 'roam/js', 'roam/css', 'roam/templates', 'November 5th, 2026',
  'Inbox', 'ToRead', 'Book Notes: Deep Work', 'Who/What/Why', 'Re: budget', 'Pros & Cons', '"Quoted" title', 'emoji 🚀 launch',
  'Ridley Scott', 'Harrison Ford', 'Emergence', 'Movies', 'Evergreen', 'Sci-fi', 'Internal links', 'INTERNAL LINKS', 'Aliases',
  'Daily notes', 'Templates', 'Canvas', 'Obsidian Publish', 'Sync', 'Plugins', 'Obsidian Hub', 'Community Plugins', 'Dataview',
];

export function synthRoamTitles(idx: VaultIndex, seed = 7): { title: string; cat: string }[] {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const sample = <T>(a: T[], n: number) => { const c = a.slice(); const o: T[] = []; while (o.length < n && c.length) o.push(c.splice(Math.floor(rnd() * c.length), 1)[0]); return o; };
  const out: { title: string; cat: string }[] = [];
  const notes = [...idx.notes.values()];
  for (const n of sample(notes, 150)) out.push({ title: n.title, cat: 'vault-title' });
  for (const n of sample(notes, 50)) out.push({ title: rnd() < 0.5 ? n.title.toUpperCase() : n.title.toLowerCase(), cat: 'case-variant' });
  const aliases = notes.flatMap((n) => n.aliases);
  for (const a of sample(aliases, 30)) out.push({ title: a, cat: 'alias' });
  const unres = [...idx.unresolved.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 300).map(([, recs]) => [...recs][0].link.target);
  for (const u of sample(unres, 50)) out.push({ title: u, cat: 'unresolved-target' });
  const isoNotes = notes.map((n) => n.title).filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t));
  for (const iso of sample(isoNotes, 40)) out.push({ title: isoToRoamDaily(iso), cat: 'daily' });
  for (let k = 0; k < 20; k++) { const d = new Date(Date.UTC(2026, 0, 1) + Math.floor(rnd() * 365) * 864e5).toISOString().slice(0, 10); out.push({ title: isoToRoamDaily(d), cat: 'daily-2026' }); }
  const nested = notes.filter((n) => n.path.split('/').length >= 2);
  for (const n of sample(nested, 30)) { const parts = n.path.slice(0, -3).split('/'); out.push({ title: parts.slice(-2).join('/'), cat: 'namespace' }); }
  for (const t of FIXED_TITLES) out.push({ title: t, cat: 'fixed' });
  const W = ['alpha', 'quartz', 'lemon', 'orbit', 'violet', 'harbor', 'falcon', 'pixel', 'tundra', 'cobalt', 'mosaic', 'ember'];
  for (let k = 0; k < 100; k++) out.push({ title: `${W[Math.floor(rnd() * W.length)]} ${W[Math.floor(rnd() * W.length)]} ${k}`, cat: 'random' });
  return out;
}
