# Developing Vaults

The user-facing guide is [README.md](README.md). Roam Depot shows that file inside Roam, so keep
developer notes here.

Roam renders the README like GitHub does: `<details>`/`<summary>` collapsibles work, Markdown inside
`<div align="center">` is kept, and a bare `https://github.com/user-attachments/assets/...` line shows
as a video. Images must use absolute URLs pinned to a commit.

## Build and test

```bash
npm install
npm test             # engine and parser tests (Node 22+)
npm run typecheck
npm run build        # writes dist/extension.js and copies README.md and CHANGELOG.md into dist/
npm run test:browser # builds, then runs a headless browser smoke test
```

The Tests workflow (`.github/workflows/tests.yml`) runs the type check, unit tests and smoke test on
GitHub Actions for every pull request and push to main, and fails if `dist/` is out of date.

`./build.sh` is what Roam Depot runs (see [docs/DEPOT-SUBMISSION.md](../docs/DEPOT-SUBMISSION.md)). It
does a clean `npm ci`, builds, and copies `dist/extension.js` to `extension.js` in this folder, where the
Depot looks for it.

## Load it in Roam (developer mode)

1. Run `npm install && npm run build`.
2. In Roam, open **Settings → Roam Depot** and turn on developer mode from the gear menu.
3. Under **Developer Extensions**, click the folder icon and choose the `dist` folder.
4. After rebuilding, click the refresh icon next to **Developer Extensions**, or press `Ctrl-D Ctrl-R`.

Local-folder developer extensions don't start by themselves after Roam restarts. Load them again from the
Roam Depot tab.

## How it works

- Each vault has its own Web Worker. It walks the vault, parses every `.md` file and builds a link index.
  The worker is bundled into `extension.js` as a string at build time and started from a Blob URL, so the
  extension stays a single file and never loads code from the network.
- The index keeps one small record per note: its path, aliases, tags, and each link's target and line. Links
  are resolved when a page asks for them, so there is no object per link. The worker keeps a handle for each
  folder, not for each note, because every live file handle also costs memory in Roam's main process. See
  [Memory](#memory).
- Parsed notes are cached in IndexedDB, one record per note, checked against the file's size and modification
  time, so later starts only re-read changed files and an edit writes one record. Removing a vault deletes
  its cache.
- Folder handles are kept in this device's IndexedDB, never in Roam settings, which sync through the graph.
- `FileSystemObserver` watches the folder, so edits made in Obsidian or any editor show up within a second.
  A file event re-checks that file. A folder that appears, goes away or moves is walked on its own
  (`VaultEngine.refreshFolders`), since a folder moved into the vault brings notes that get no events of
  their own; a moved folder's notes keep their parse under the new path. Only an `errored` record, or an
  `unknown` one without a path (events lost somewhere in the vault), walks the whole vault again.
- Daily notes use the format in `.obsidian/daily-notes.json`, falling back to `YYYY-MM-DD`.
- Similar names: a page that no note is lists notes whose name or alias is close to its title. The scoring,
  its guards (every word must start with the same letter, keep its numbers, and so on) and the highlighted
  letters (`diffMarks`) are in `src/core/fuzzy.ts`. The lookup runs on the vault's SQLite database
  (`src/sql/fuzzy.ts`, see below): each name and alias is a row cut into trigrams by triggers, and a title's
  rarer trigrams pull the 50 closest keys for `fuzzy.ts` to judge (2 to 5 ms a page at 20,000 notes, 5 MB of
  database). When SQLite can't load, `src/core/fuzzy-index.ts` does the same in memory, with notes in buckets
  by the first letters of their words. To measure quality, latency and size of both:
  `npm pack wordlist-english && tar xzf wordlist-english-*.tgz` once, then
  `WORDS=path/to/package node --expose-gc test/fuzzy-bench.mjs [notes]`.
- The scan skips dot-folders, paths matched by the vault's `.gitignore` files (git's rules, through the
  `ignore` package, nearest file decides) and Obsidian's Excluded files (`userIgnoreFilters` in
  `.obsidian/app.json`: a plain entry is a path prefix, `/.../` a regular expression tested against file
  paths). Ignored folders are never opened. The watcher drops events under them, and a change to a
  `.gitignore`, `app.json` or `daily-notes.json` rescans. See `src/core/ignore.ts`.
- CSS classes are prefixed `rv-`, and every DOM node the extension adds carries a data attribute, so
  `onunload` can remove all of them.

The design and measurements are in [docs/FEASIBILITY.md](../docs/FEASIBILITY.md).

## SQLite index (prototype)

On this branch the worker keeps the index in SQLite instead of JavaScript maps. Full-text search over the
notes was prototyped on top of it and taken out again (on the backlog); its code is in commit 1b8305b.

- SQLite is the official WebAssembly build, `@sqlite.org/sqlite-wasm` (pinned). `build.mjs` gzips its `.wasm`
  and inlines it in `extension.js` as base64 (Roam Depot allows no code from the network). The page compiles it
  once (`compileSqlite` in `main/index.ts`) and hands the compiled module to each vault's worker in `open`.
  If that fails, the worker uses the in-memory index as before.
- Each vault has its own database in the origin private file system, in `.roam-vaults/<poolName(id)>`, through
  the `opfs-sahpool` VFS (`sql/db.ts`). A pool can be open in one worker at a time: a second Roam window on the
  same vault gets a database in memory instead. Removing a vault deletes its folder.
- The tables are in `sql/schema.ts`: add a step at the end of `MIGRATIONS`. Step 2 adds the similar-name
  tables (`sql/fuzzy.ts`), kept in step with the notes through the index's file listener. `SqlIndex` (`sql/sql-index.ts`)
  overrides the lookups `VaultIndex` makes (`pathsNamed`, `eachLinker`, `aliasPaths`, ...), so link resolution
  and its tie-break rules are the same code. `test/sql.test.ts` checks both indexes answer every query the same.
- The database is the parse cache: each scan updates it in place (`VaultEngine.buildInPlace`), and the
  IndexedDB cache is dropped. Writes are batched in a transaction that `flush()` commits. A scan that stops
  part way leaves the notes it wrote, so the next one carries on from there.

## Real Roam run (GitHub Actions)

`.github/workflows/real-roam.yml` runs `test/real-roam/run.mjs` on pull requests that touch `extension/`
and on demand (Actions > Real Roam > Run workflow). It installs Roam's Linux desktop app, starts it under
Xvfb, signs in to the hosted test graph, loads `dist/` through Roam Depot's developer mode (from a local
URL), and drives it over the DevTools protocol with Playwright. It checks the settings tab, a small vault
on a real page (including a live edit), memory through a 20,000-note vault's first scan and Rescans, and
that a scan which crashed Roam waits for Rescan. RESULTS.md and PNG screenshots are uploaded as the run's
artifact; the memory limits are at the top of `run.mjs`.

It needs the repository secrets `ROAM_EMAIL` and `ROAM_PASSWORD` (a Roam account that can open the test
graph) and is skipped without them, including on pull requests from forks. The repository variable
`ROAM_GRAPH` picks another graph. The script never logs, saves or photographs the credentials: no
screenshot is taken until the graph is open, and Roam's own log and console stay out of the output.

To run it by hand: install the Roam `.deb` and Xvfb, start `Xvfb :99`, then
`DISPLAY=:99 ROAM_EMAIL=… ROAM_PASSWORD=… node test/real-roam/run.mjs` (`NOTES=2000` for a quicker run).
A Roam profile that is already signed in skips the sign-in.

## Memory

A vault's cost is paid in three places: the worker's JavaScript heap (the index), the rest of Roam's renderer
process, and Roam's main process, which holds an object for every file handle a page keeps. Measure all
three when changing the indexer:

```bash
npm run build
node test/memory-bench.mjs            # 20,000 generated notes; pass a number for another size
DISK=1 node test/memory-bench.mjs     # the same, with the vault in a real folder on disk
```

It loads `dist/extension.js` in headless Chromium against a stand-in Roam page and a generated vault, then
prints the worker heap and each process's private memory after a first index, a start from the cache, some
browsing, some edits and a rescan. Pass a second argument to measure another build's `dist` folder.

Without `DISK=1` the vault lives in the browser's private file system. With it, the vault is written to a
temporary folder and handed to the page the way a dropped folder is, so the handles, the reads and the file
watcher are the ones a picked folder gets. That run also checks a note whose name is not NFC on disk, and
folders created, moved in, renamed, deleted and moved to `.trash` while the vault is open, without a
walk of the whole vault. Neither is Roam's desktop app, so compare runs of two builds rather
than reading the numbers as what a vault costs there.

Things that made 0.1.0 heavy, to keep out:

- A `FileSystemFileHandle` kept per note. About 10 KB each across the two processes.
- File handles and `File` objects left for the garbage collector during a scan. It can't see what they
  cost, so 40,000 of them piled up before it ran. `madeHandles()` in `worker.ts` brings it forward.
- An object per link, in several lookup sets. A vault has ten or more links per note.
- Strings read back from IndexedDB. Each is its own copy; `intern()` them when loading.
- Arrays filled with `push()` and kept for good. They hold spare room; `slice()` them once filled.
- Rewriting the whole cache after a change.
