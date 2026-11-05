// Hand-rolled "YAML-lite" for Obsidian frontmatter. Handles what Obsidian
// properties actually produce: `key: scalar`, `key: [a, "b"]`, block lists
// (`key:` + `  - item` or `- item` at column 0), quoted scalars, comments,
// block scalars (| >). Nested maps are skipped (but still scanned for links).
// Differentially tested against the `yaml` package (src/harness/yaml-diff.ts).

export interface FrontmatterResult {
  bodyStart: number;               // char offset where the markdown body starts
  bodyStartLine: number;           // 0-based line where the body starts
  raw: string | null;              // raw YAML text (without fences)
  props: Record<string, string | string[]> | null;
  error: string | null;
}

const NO_FM: FrontmatterResult = { bodyStart: 0, bodyStartLine: 0, raw: null, props: null, error: null };

export function splitFrontmatter(text: string): FrontmatterResult {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // BOM
  if (!text.startsWith('---', i)) return { ...NO_FM, bodyStart: i };
  let j = i + 3;
  while (text[j] === ' ' || text[j] === '\t') j++;
  if (text[j] === '\r') j++;
  if (text[j] !== '\n') return { ...NO_FM, bodyStart: i };
  const yamlStart = j + 1;
  // find closing '---' line
  let p = yamlStart, line = 1;
  while (p <= text.length) {
    let e = text.indexOf('\n', p);
    if (e < 0) e = text.length;
    const l = text.slice(p, e).replace(/\r$/, '');
    if (/^---\s*$/.test(l)) {
      const raw = text.slice(yamlStart, p);
      const { props, error } = parseYamlLite(raw);
      return { bodyStart: Math.min(e + 1, text.length), bodyStartLine: line + 1, raw, props, error };
    }
    if (e >= text.length) break;
    p = e + 1; line++;
  }
  // unclosed: Obsidian treats the whole thing as body
  return { ...NO_FM, bodyStart: i, error: 'unclosed-frontmatter' };
}

function unquote(s: string): string {
  s = s.trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\(["\\\/nt])/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function stripComment(s: string): string {
  // plain scalars: ' #' starts a comment. Respect quotes.
  let q: string | null = null;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { if (k === 0 || /[\s,\[]/.test(s[k - 1])) q = c; continue; }
    if (c === '#' && (k === 0 || s[k - 1] === ' ' || s[k - 1] === '\t')) return s.slice(0, k).trimEnd();
  }
  return s;
}

function splitFlow(inner: string): string[] {
  const out: string[] = [];
  let depth = 0, q: string | null = null, cur = '';
  for (const c of inner) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out.map((x) => unquote(x)).filter((x) => x !== '');
}

function scalarOrFlow(v: string): string | string[] {
  v = stripComment(v).trim();
  if (v.startsWith('[') && v.endsWith(']')) return splitFlow(v.slice(1, -1));
  return unquote(v);
}

const detach = (s: string) => (s.length < 13 ? s : (' ' + s).slice(1)); // see parser.ts

export function parseYamlLite(raw: string): { props: Record<string, string | string[]>; error: string | null } {
  const r = parseYamlLiteInner(raw);
  const props: Record<string, string | string[]> = {};
  for (const k of Object.keys(r.props)) { const v = r.props[k]; props[detach(k)] = Array.isArray(v) ? v.map(detach) : detach(v); }
  return { props, error: r.error };
}

function parseYamlLiteInner(raw: string): { props: Record<string, string | string[]>; error: string | null } {
  const props: Record<string, string | string[]> = {};
  const lines = raw.split(/\r?\n/);
  let error: string | null = null;
  let k = 0;
  while (k < lines.length) {
    const l = lines[k];
    if (/^\s*(#.*)?$/.test(l)) { k++; continue; }
    const m = /^("[^"]*"|'[^']*'|[^\s:#][^:]*?)\s*:(?:[ \t]+(.*?))?\s*$/.exec(l);
    if (!m || /^\s/.test(l)) { if (!error) error = `unparsed line ${k + 1}`; k++; continue; }
    const key = unquote(m[1]);
    const v = m[2] ?? '';
    k++;
    if (v === '' || /^[|>][+-]?\d*$/.test(v)) {
      const block = /^[|>]/.test(v);
      const items: string[] = [];
      const textLines: string[] = [];
      while (k < lines.length) {
        const n = lines[k];
        if (/^\s*$/.test(n)) { k++; continue; }
        const li = /^(\s*)-(?:\s+(.*))?$/.exec(n);
        if (!block && li) {
          // block sequence item (indented, or at column 0 which is also valid YAML)
          items.push(unquote(stripComment(li[2] ?? '')));
          k++; continue;
        }
        if (/^\s/.test(n)) { textLines.push(n.trim()); k++; continue; } // nested map / block scalar
        break;
      }
      if (block) props[key] = textLines.join(v.startsWith('>') ? ' ' : '\n');
      else if (items.length) props[key] = items.filter((x) => x !== '');
      else if (textLines.length) props[key] = '[object]';
      else props[key] = '';
    } else {
      props[key] = scalarOrFlow(v);
    }
  }
  return { props, error };
}

/** Obsidian: `aliases`/`alias` (any case); string scalars are comma-split (legacy). */
export function extractAliases(props: Record<string, string | string[]> | null): string[] {
  if (!props) return [];
  const out: string[] = [];
  for (const key of Object.keys(props)) {
    if (!/^aliases?$/i.test(key)) continue;
    const v = props[key];
    const arr = Array.isArray(v) ? v : v.split(',');
    for (const a of arr) { const t = a.trim(); if (t && t !== '[object]') out.push(t.normalize('NFC')); }
  }
  return out;
}

/** Obsidian: `tags`/`tag`; strings split on commas AND whitespace; leading '#' stripped. */
export function extractFmTags(props: Record<string, string | string[]> | null): string[] {
  if (!props) return [];
  const out: string[] = [];
  for (const key of Object.keys(props)) {
    if (!/^tags?$/i.test(key)) continue;
    const v = props[key];
    const arr = Array.isArray(v) ? v : v.split(/[,\s]+/);
    for (const a of arr) {
      const t = a.trim().replace(/^#/, '');
      if (t && t !== '[object]') out.push(t.normalize('NFC'));
    }
  }
  return out;
}
