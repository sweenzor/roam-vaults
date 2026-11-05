// Catalogs real-world edge cases in a vault. node src/harness/edge-cases.ts <vault> <name>
import fs from 'node:fs';
import path from 'node:path';
import { walk, readAllSync } from './walk.ts';
import { parseNote, deadRanges } from '../core/parser.ts';
import { splitFrontmatter } from '../core/frontmatter.ts';
import { VaultIndex, nfcLower } from '../core/vault-index.ts';
import * as F from '../core/types.ts';

const [root, name0] = process.argv.slice(2);
const name = name0 + (process.argv.includes('--nearby') ? '-nearby' : '');
const w = walk(root);
const texts = readAllSync(w.md);
const notes = [...texts.entries()].map(([p, s]) => parseNote(p, s));
const idx = new VaultIndex();
idx.preferNearby = process.argv.includes('--nearby');
idx.build(notes, w.other);

const cats: Record<string, { n: number; ex: string[] }> = {};
const hit = (cat: string, ex?: string, max = 4) => { const c = (cats[cat] ??= { n: 0, ex: [] }); c.n++; if (ex !== undefined && c.ex.length < max && !c.ex.includes(ex)) c.ex.push(ex.length > 140 ? ex.slice(0, 140) + '…' : ex); };

// ---- file names
for (const f of w.md) {
  const raw = f.rawName;
  const base = raw.slice(raw.lastIndexOf('/') + 1);
  if (raw !== raw.normalize('NFC')) hit('filename: NFD-encoded on disk', raw);
  if (/\p{Extended_Pictographic}/u.test(base)) hit('filename: emoji', raw);
  if (/[^\x00-\x7f]/.test(base)) hit('filename: non-ASCII', raw);
  if (/\.MD$|\.Md$|\.mD$/.test(base)) hit('filename: uppercase .MD extension', raw);
  if (/^\s|\s\.md$/i.test(base)) hit('filename: leading/trailing whitespace', raw);
  if (/[#^\[\]|]/.test(base)) hit('filename: contains link-breaking char #^[]|', raw);
  if (/[?:*"<>\\]/.test(base)) hit('filename: Windows-illegal char', raw);
  if (/^\d{4}-\d{2}-\d{2}/.test(base)) hit('filename: starts with ISO date', raw);
  if (/\.[^.]+\.md$/i.test(base)) hit('filename: extra dot (e.g. v1.2.md, x.excalidraw.md)', raw);
}
for (const o of w.other) if (!/\.[A-Za-z0-9]+$/.test(o)) hit('file without extension', o);
const extCount: Record<string, number> = {};
for (const o of w.other) { const e = (/\.([A-Za-z0-9]+)$/.exec(o)?.[1] ?? '(none)').toLowerCase(); extCount[e] = (extCount[e] ?? 0) + 1; }
for (const [k, paths] of idx.byName) {
  const md = paths.filter((p) => /\.md$/i.test(p));
  if (md.length > 1) {
    hit('duplicate md basename (case-insensitive)', `${k}: ${md.slice(0, 3).join(' | ')}${md.length > 3 ? ` (+${md.length - 3})` : ''}`);
    const bases = new Set(md.map((p) => p.slice(p.lastIndexOf('/') + 1)));
    if (bases.size > 1) hit('duplicate basename differing only by case', [...bases].join(' | '));
  }
  if (paths.length > 1 && !md.length) hit('duplicate attachment basename', `${k} x${paths.length}`);
}

// ---- content
for (const [p, s] of texts) {
  if (s.charCodeAt(0) === 0xfeff) hit('content: UTF-8 BOM', p);
  if (s.includes('\r\n')) hit('content: CRLF line endings', p);
  const fm = splitFrontmatter(s);
  if (fm.raw !== null) hit('frontmatter: present');
  if (fm.error === 'unclosed-frontmatter') hit('frontmatter: unclosed ---', p);
  else if (fm.error) hit('frontmatter: line not understood by YAML-lite', `${p}: ${fm.error}`);
  if (fm.props) for (const k of Object.keys(fm.props)) if (/^aliases?$/i.test(k) && !Array.isArray(fm.props[k]) && fm.props[k] !== '') hit('frontmatter: aliases as scalar string (comma-split)', `${p}: ${k}: ${fm.props[k]}`);
  const dead = deadRanges(s, fm.bodyStart);
  for (let k = 0; k < dead.length; k += 2) {
    const seg = s.slice(dead[k], dead[k + 1]);
    const n = (seg.match(/\[\[[^\]\n]+\]\]/g) ?? []).length;
    if (n) {
      const kind = seg.startsWith('%%') ? '%% comment' : seg.startsWith('<!--') ? 'HTML comment' : seg.startsWith('$$') ? '$$ math' : /^[ \t>]*(```|~~~)/.test(seg) ? 'code fence' : 'inline code';
      for (let q = 0; q < n; q++) hit(`ignored [[link]] inside ${kind}`, `${p}: ${seg.split('\n').find((l) => l.includes('[['))?.trim()}`);
    }
    if (dead[k + 1] === s.length && /^%%/.test(seg) && seg.indexOf('%%', 2) < 0) hit('unclosed %% (hides rest of file)', p);
    if (dead[k + 1] === s.length && /^[ \t>]*(```|~~~)/.test(seg) && !/\n[ \t>]*(```|~~~)[`~]*[ \t\r]*$/.test(seg)) hit('unclosed code fence (runs to EOF)', p);
  }
  const masked = s; // raw checks below are heuristics on raw text
  for (const m of masked.matchAll(/\[\[[^\]\n]*\n/g)) hit('"[[" not closed on same line (not a link)', `${p}: ${m[0].trim()}`);
  for (const m of masked.matchAll(/\[\[\s*\]\]/g)) hit('empty [[ ]]', `${p}: ${m[0]}`);
  for (const m of masked.matchAll(/\]\(([^()<>\n]*\s[^()<>\n]*\.md)\)/g)) hit('markdown link with raw spaces (not a link in Obsidian)', `${p}: ${m[0]}`);
  for (const m of masked.matchAll(/<a\s[^>]*href="([^"]+)"/g)) if (!/^[a-z]+:/i.test(m[1])) hit('HTML <a href> to vault file (not indexed)', `${p}: ${m[0]}`);
  for (const m of masked.matchAll(/\[[^\]\n]+\]\[[^\]\n]*\]/g)) hit('reference-style markdown link (not indexed)', `${p}: ${m[0]}`);
  for (const m of masked.matchAll(/\[\[[^\]\n]*(\{\{|<%)[^\]\n]*\]\]/g)) hit('template placeholder inside [[ ]]', `${p}: ${m[0]}`);
  if (/```dataview/.test(s)) hit('dataview code block (links generated at runtime, invisible to us)', p);
  if (/```query/.test(s)) hit('obsidian search ```query block', p);
}
const FLAG_NAMES: [number, string][] = [[F.F_TRIMMED, 'leading/trailing whitespace in target'], [F.F_ESCAPED_PIPE, 'table-escaped pipe [[a\\|b]]'],
  [F.F_RELATIVE, 'relative ./ ../ markdown link'], [F.F_ABSOLUTE, 'leading / (vault-absolute)'], [F.F_DECODE_FAIL, 'decodeURIComponent failed (literal %)'],
  [F.F_UNQUOTED_YAML, 'unquoted [[link]] in YAML (parses as nested list)'], [F.F_HAS_MD_EXT, 'explicit .md in target'], [F.F_EMPTY_ALIAS, 'empty alias [[a|]]'], [F.F_ANGLE, 'angle-bracket dest <...>']];
for (const recs of idx.outgoing.values()) for (const r of recs) {
  const l = r.link;
  const show = `${r.src}:${l.line + 1}: ${l.embed ? '!' : ''}${l.kind === 'md' ? `[${l.display}](${l.target}${l.subpath})` : `[[${l.target}${l.subpath}${l.display !== null ? '|' + l.display : ''}]]`}`;
  for (const [f, n] of FLAG_NAMES) if (l.flags & f) hit(`link: ${n}`, show);
  if (l.kind === 'prop') hit(`link: in frontmatter property "${l.prop}"`, show, 2);
  if (l.target === '' && l.subpath) hit('link: self-link [[#Heading]]', show, 2);
  if ((l.subpath.match(/#/g) ?? []).length > 1) hit('link: nested heading path [[A#B#C]]', show);
  if (l.subpath && !l.subpath.startsWith('#^') && /[^\p{L}\p{N}\s#-]/u.test(l.subpath.slice(1))) hit('link: heading subpath with punctuation', show);
  if (l.embed) { const ext = /\.([a-z0-9]+)$/i.exec(l.target)?.[1]?.toLowerCase() ?? 'md(note)'; hit(`embed: .${ext}`, show, 2); }
  if (l.embed && l.display && /^\d+(x\d+)?$/.test(l.display)) hit('embed: size spec ![[img|100x200]]', show, 2);
  if (r.key.includes('/')) hit(r.resolved ? 'link: path-qualified, resolved' : 'link: path-qualified, unresolved', show, 3);
  if (r.resolved === null && /[?:*"<>|]/.test(l.target)) hit('link: target has filename-illegal char (can never resolve)', show);
  if (r.resolved === null && l.target !== '') hit('link: unresolved', show, 6);
  if (r.candidates > 1) {
    hit('link: ambiguous (multiple candidates, tie-broken)', `${show} -> ${r.resolved} (of ${r.candidates})`);
    const top = (p: string) => p.split('/')[0];
    if (top(r.resolved!) !== top(r.src) && r.src.includes('/')) hit('link: ambiguous AND resolved into a different top-level folder', `${show} -> ${r.resolved}`);
  }
  if (r.resolved && l.target !== '' && r.resolved.slice(r.resolved.lastIndexOf('/') + 1).replace(/\.md$/i, '') !== l.target.slice(l.target.lastIndexOf('/') + 1).replace(/\.md$/i, ''))
    hit('link: resolved only case-insensitively', `${show} -> ${r.resolved}`);
}
for (const n of notes) for (const t of n.tags) { if (t.includes('/')) hit('tag: nested', `#${t}`); if (/[^\x00-\x7f]/.test(t)) hit('tag: non-ASCII', `#${t}`); }

const out = { name, mdFiles: w.md.length, otherFiles: w.other.length, attachmentExts: extCount, categories: Object.fromEntries(Object.entries(cats).sort()) };
fs.writeFileSync(path.join(import.meta.dirname, `../../out/edges-${name}.json`), JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out.categories)) console.log(`${String(v.n).padStart(6)}  ${k}${v.ex.length ? '\n          e.g. ' + v.ex.join('\n               ') : ''}`);
console.log('attachment extensions:', JSON.stringify(extCount));
