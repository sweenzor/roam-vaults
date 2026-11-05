# Vault indexer spike (throwaway)

A feasibility prototype written to answer one question: can a Roam extension parse an
Obsidian-style vault, resolve its links and match notes to Roam page titles fast enough
inside a browser renderer? **Answer: yes.** See [`../docs/FEASIBILITY.md`](../docs/FEASIBILITY.md) §6.

This is not production code. It has no Roam integration and nothing in it is final. It is
here as a measured reference for the real implementation.

## Layout

| Path | What |
|---|---|
| `src/core/` | Browser-safe core with no Node APIs: `parser.ts` (masks code, comments and math, then extracts wikilinks, markdown links, embeds, tags, block ids and frontmatter), `frontmatter.ts` (a "YAML-lite" parser), `vault-index.ts` (incremental resolver approximating Obsidian, plus backlinks and unresolved-link maps), `matcher.ts` (Roam title → vault matches in confidence tiers), `dates.ts` (Roam daily title ↔ moment-style formats) |
| `src/harness/` | Node-only tools: directory walker, benchmark, synthetic vault generator, edge-case census, YAML differential test, headless-Chrome benchmark |
| `src/test/` | Unit tests for tricky syntax |
| `browser/` | Page and worker used by the headless-Chrome benchmark (reads files through `FileSystemHandle`) |

## Running (Node 22+, which runs the `.ts` files directly)

```bash
npm install                                   # only devDependency is `yaml`, used by the differential test
node --test src/test/parser.test.ts
node src/harness/gen-synthetic.ts data/synthetic 20000
node --expose-gc src/harness/bench.ts data/synthetic --name synthetic --truth data/synthetic-truth.json
node src/harness/demo.ts <vaultDir> "Some Roam Title" "Another Title"
```

Test vaults used in the report (clone them into `data/`, which git ignores):
`obsidianmd/obsidian-help`, `kepano/kepano-obsidian`, `obsidian-community/obsidian-hub`.
