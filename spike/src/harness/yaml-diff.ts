// Differential test: hand-rolled YAML-lite vs the `yaml` package for the fields we use.
// node src/harness/yaml-diff.ts <vault>...
import YAML from 'yaml';
import { walk, readAllSync } from './walk.ts';
import { splitFrontmatter, extractAliases, extractFmTags, parseYamlLite } from '../core/frontmatter.ts';

const flat = (v: unknown): string[] => (v == null ? [] : Array.isArray(v) ? v.flatMap(flat) : typeof v === 'object' ? Object.values(v as object).flatMap(flat) : [String(v)]);
function refFields(obj: Record<string, unknown>) {
  const props: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(obj)) props[k] = Array.isArray(v) ? v.filter((x) => x != null).map((x) => (Array.isArray(x) ? `[${flat(x).join(',')}]` : String(x))) : v == null ? '' : typeof v === 'object' ? '[object]' : String(v);
  return { aliases: extractAliases(props), tags: extractFmTags(props) };
}
for (const root of process.argv.slice(2)) {
  const w = walk(root);
  let fm = 0, yamlErr = 0, same = 0, diff = 0, liteMs = 0, yamlMs = 0;
  const ex: string[] = [];
  for (const [p, s] of readAllSync(w.md)) {
    const r = splitFrontmatter(s);
    if (r.raw === null) continue;
    fm++;
    let t = performance.now();
    const lite = parseYamlLite(r.raw);
    liteMs += performance.now() - t;
    const a = { aliases: extractAliases(lite.props), tags: extractFmTags(lite.props) };
    let ref: Record<string, unknown>;
    t = performance.now();
    try { ref = YAML.parse(r.raw) ?? {}; } catch (e) { yamlMs += performance.now() - t; yamlErr++; if (ex.length < 8) ex.push(`YAML ERROR ${p}: ${(e as Error).message.split('\n')[0]}`); continue; }
    yamlMs += performance.now() - t;
    if (typeof ref !== 'object' || Array.isArray(ref)) { yamlErr++; continue; }
    const b = refFields(ref);
    if (JSON.stringify(a) === JSON.stringify(b)) same++;
    else { diff++; if (ex.length < 8) ex.push(`DIFF ${p}: lite=${JSON.stringify(a)} yaml=${JSON.stringify(b)}`); }
  }
  console.log(JSON.stringify({ root, filesWithFrontmatter: fm, agree: same, disagree: diff, yamlPackageErrors: yamlErr, liteMs: +liteMs.toFixed(1), yamlPkgMs: +yamlMs.toFixed(1) }));
  for (const e of ex) console.log('   ', e.slice(0, 220));
}
