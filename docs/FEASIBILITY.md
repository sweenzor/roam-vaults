# Roam ↔ Markdown vaults: feasibility study

*Research date: 2026-11-05. Status: research complete; nothing has been built against Roam yet.*

## The idea

A Roam Research extension for the desktop app that:

1. **Registers local vaults.** These are directories of markdown files joined by `[[wikilinks]]` or
   markdown links: Obsidian vaults, Google's Open Knowledge Format (OKF) bundles, Logseq and Foam folders.
2. **Browses them** from inside Roam.
3. **Shows associations** on any Roam page between that page and vault notes. These stay visually
   distinct from Roam's own graph references.

## Verdict: workable, with no hard blockers

Each piece was checked against primary sources, the unpacked Roam desktop app, Electron and
Chromium source, or a working prototype:

| Question | Answer | Confidence |
|---|---|---|
| Can extension JS in Roam desktop read a local folder? | **Yes**, through the browser's File System Access API (`showDirectoryPicker`). Roam's own developer mode and its markdown importer already use it. | High |
| Does access persist across app restarts without re-prompting? | **Probably yes on desktop.** Roam's Electron permission setup grants file-system permission unconditionally. Chrome on the web needs one click per visit, or "Allow on every visit". | Medium. Inferred from source; **must be tested in the real app first** (§9). |
| Can it watch the vault for changes? | **Yes.** `FileSystemObserver` is stable in Roam desktop's Chromium 150. | Medium-high |
| Is indexing fast enough? | **Yes.** A 20k-note vault parses and indexes in about 1 s of CPU. Per-page lookups take microseconds. **Disk reads are the bottleneck**: about 4–16 s for a cold first scan of 20k files, near-instant later with a cache. | High (measured) |
| Can it put UI on a Roam page? | **Yes, but there is no official hook.** It means DOM injection near Linked References, which is what every comparable extension does. | High |
| Can it have a full "vault browser" view? | **Yes.** `roamAlphaAPI.ui.mainWindow.registerComponent` mounts a full-page React view. It is a young API. | Medium-high |
| Can vault and Roam matches be distinguished cleanly? | **Yes.** The vault data never enters Roam's database, so it can only appear in our own styled UI. | High |
| Will Roam Depot accept it? | **Probably.** It needs no network access (good). File-system access and a Web Worker may draw reviewer questions. Personal use through developer mode avoids review entirely. | Medium |

The biggest *product* risk is not technical feasibility. It is **matching quality**: Roam titles and
markdown filenames follow different rules (§5), so associations need confidence tiers instead of a
single yes/no.

---

## 1. How the extension can reach local files

### 1.1 What the Roam desktop app actually is (verified by unpacking it)

Roam's public electron-builder update feed (`https://roam-electron-deploy.s3.us-east-2.amazonaws.com/latest-linux.yml`)
lists **v0.0.42, released 2026-10-28**. We downloaded the `.deb`, checked its sha512 against the
feed, and unpacked it **without running it**.

- **Runtime:** **Electron 43.8.0 / Chromium 150.0.7871.250** (version string in the binary).
- **What it loads:** a thin shell that loads the live `https://roamresearch.com/?server-port=<port>#/app`.
  Extensions therefore run on the `https://roamresearch.com` origin, as they do in a browser.
- **Window security:** `contextIsolation: true` and `nodeIntegration: false`, with Electron's
  default sandbox. **Extensions get no Node.js and no `fs`.**
- **The preload exposes only flags**, `roamDesktopIpcBytes` (plus `roamDesktopCustomTitleBarSupported`
  on Windows), and a `postMessage` → IPC bridge.
  - The bridge serves a fixed list of operations confined to Roam's own `userData/local-graph-uploads/<graph>/` directory.
  - It is private and undocumented. **Do not use it.**
- **Permissions:**
  - `session.defaultSession.setPermissionCheckHandler(Mba)`, where `Mba` returns `permission !== "deprecated-sync-clipboard-read"`. That means *everything else is allowed*.
  - There is **no** `setPermissionRequestHandler`, which Electron treats as grant.
  - There is no `file-system-access-restricted` listener.
- **Electron's own logic for folder access:** in Electron 43's `file_system_access_permission_context.cc`,
  `PermissionGrantImpl::GetStatus()` returns **GRANTED whenever the app's check handler says yes**. Roam's always says yes. So:
  - The folder picker still needs a user click.
  - After that, there is no "Let this site view files?" prompt.
  - A directory handle saved in IndexedDB should report `queryPermission() === "granted"` after an app restart.
  - *We could not run the app to confirm this.* It is the first thing to test (§9).
- **Roam's local server:** an Express server on `127.0.0.1:3333+` (the documented Roam Local API).
  It is *inbound*, for other apps to query Roam. It does not serve files.
- **CSP:** a third-party header scan of roamresearch.com shows CSP limited to `frame-ancestors`.
  - With no `connect-src`, `fetch('http://127.0.0.1:…')` is not blocked. `blob:` URLs are not blocked either.
  - Published extensions already reach Ollama, AnkiConnect and local MCP gateways on localhost.
- **Local Network Access:** Electron 43 disables Chrome's `LocalNetworkAccessChecks` feature, so
  desktop shows no Local Network Access prompt. Chrome 142+ on the web *does* prompt.

### 1.2 Access strategies, ranked

| # | Strategy | Works on | Pros | Cons / what breaks it |
|---|---|---|---|---|
| **1** | **File System Access API**: `showDirectoryPicker()` or drag a folder in; handle stored in IndexedDB; `FileSystemObserver` for live updates | Roam desktop, Chrome/Edge web | Nothing to install. Live updates. Read-write possible. Probably prompt-free after the first pick on desktop. | Chromium only. Some folders can't be picked (below). Slow cold scan on huge vaults. Breaks if Roam adds a permission handler that denies `fileSystem`; if Roam removes its check handler, it costs one click per launch. |
| 2 | **Snapshot import** with `<input webkitdirectory>` | Everywhere, including Firefox/Safari | Universal fallback | No lasting access and no live updates; the user re-imports to refresh. |
| 3 | **Local companion process**: a tiny Go/Rust/Node server on `127.0.0.1` serving the index as JSON | Desktop + web | Reliable watching; handles huge vaults; could serve several apps | Install, signing and autostart burden. Must be secured with a token, `Origin` and `Host` checks, and no `*` CORS. Chrome web shows the Local Network Access prompt. Depot reviewers will ask about it. |
| 4 | **Obsidian Local REST API plugin** (HTTP mode, port 27123) | Desktop + web | Uses Obsidian's own link index (`links`, `backlinks`, `unresolvedLinks`), which is authoritative | Obsidian must be running, the HTTP server must be enabled (it's off by default; HTTPS needs the plugin's own certificate trusted, Roam has no cert-error handler), and an API key pasted in |
| ✗ | Roam's private IPC, Roam's local server, `file://` | — | — | Not viable |

**Recommendation:** use strategy 1 as the engine and strategy 2 as the fallback for browsers without
folder access. Keep strategy 4 as an optional "use Obsidian's index" toggle later. Avoid strategy 3
unless real vaults turn out too large for strategy 1.

**Folders Chromium will not let you pick.** The rules come from Chromium's blocklist, which Electron
applies:
- **Blocked as a whole, but subfolders are fine:** the home folder itself, `~/Documents`, `~/Desktop`
  and `~/Downloads`. So `~/Documents/MyVault` works, but `~/Documents` does not.
- **Blocked entirely:** `~/Library` on macOS, *except* `~/Library/Mobile Documents/…`, where iCloud
  Obsidian vaults live (allowed), plus `CloudStorage` and `Containers`. Also `~/.ssh`, `~/.config`
  and system folders.
- Picking a *parent* of a blocked folder is also blocked.
- Roam doesn't listen for the "restricted folder" event, so the UI must tell users to pick the vault
  folder itself.

---

## 2. The Roam side: what the extension API gives us

Sources: the official developer docs (read through roamdocs.fyi, a mirror of Roam's developer
documentation and help graphs), the `Roam-Research/roam-depot` repo and its review threads, and the
source of about ten published extensions.

### Useful APIs

| Need | API | Notes |
|---|---|---|
| Lifecycle | `export default { onload({extensionAPI}), onunload() }` | We must clean up our own DOM, observers and workers |
| Settings UI | `extensionAPI.settings.panel.create(...)` | **Settings sync across devices and are stored in the graph.** Keep vault handles and paths in per-device IndexedDB, not in settings. |
| Full-page vault browser | `roamAlphaAPI.ui.mainWindow.registerComponent(id, ReactComponent)` / `openComponent` | Ideal for "browse vaults". Documented but young. |
| Current page | `ui.mainWindow.getOpenPageOrBlockUid()`, `getOpenView()`, `hashchange` | |
| Right-click on a `[[link]]` | `ui.pageRefContextMenu.addCommand` | Context includes the `ref-uid`, so we can offer "Open in vault" |
| Right-click on a page title | `ui.pageContextMenu.addCommand` | Context includes `page-title` |
| Commands | `extensionAPI.ui.commandPalette.addCommand`, `ui.slashCommand.addCommand` | "Vault: search", "Vault: add vault", "Vault: reindex" |
| Graph view | `ui.graphView.addCallback({callback({cytoscape})})` | Can inject vault nodes into the page-level graph in a distinct color/shape |
| Render Roam content | `ui.components.renderString/renderBlock/renderPage` | For showing Roam snippets inside the vault browser |
| Read Roam data | `data.async.q` / `data.async.pull` (preferred), `addPullWatch` (one entity at a time) | No global change feed. Need all page titles plus a cheap delta via `:edit/time`. |
| Platform / graph | `platform.isDesktop`, `graph.name`, `graph.type`, `graph.isEncrypted`, `util.dateToPageTitle` / `pageTitleToDate` | Built-in daily-note title conversion |

### Missing APIs, and the workarounds

- **No hook for adding a section to a page.**
  - Every comparable extension (Alias Finder, Discourse Graph, zoteroRoam, Page references counter)
    injects into the DOM: it finds `.roam-article .rm-reference-main` or `.rm-title-display`, then
    re-mounts from a debounced `MutationObserver` with `data-*` guards against double-mounting.
  - These selectors have been stable since 2020 and are documented in Roam's CSS docs. Roam still
    warns that "class names are not a formal API."
- **No custom content in the right sidebar.** Sidebar windows are limited to block, outline, mentions,
  graph and search types. Use a floating panel or the full-page component instead.
- **No inline-render hook for links.**
  - To badge `[[Foo]]` when a vault note exists, generate CSS such as
    `.rm-page-ref[data-link-title="Foo"]::after{…}`. This survives Roam's re-renders with no observers.
  - Alternatively, post-process the DOM.
- **No way to register a `{{custom-component}}`.** The RoamJS convention is to let Roam render an
  unknown `{{word}}` as a button and replace it with our own component. That is an option if we ever
  want explicit `{{vault: Note}}` links.

### Roam Depot review constraints

Some of these are written rules; others are reviewer practice seen in PR threads.

- The repo must build from **unminified source** via a `build.sh`.
- Dependencies are "scrutinized heavily", so keep them minimal. The prototype's core has **zero runtime dependencies**.
- **No remote or dynamic code loading**: no `import()` from a URL, no remote CSS.
- **Every network destination is audited.** This design makes **no network requests**, which is a selling point.
- Reviewers test performance on large graphs.
- Must use Roam's provided React 18 and Blueprint 3 instead of bundling its own copies.
- **Open question:** whether reviewers accept a Web Worker created from a `Blob` of bundled code.
  There is a precedent of a worker allowed to load TensorFlow. Fallback: run the indexer on the main
  thread in idle-time chunks. Parsing is about 1 s total for 20k notes, so chunking is fine.
- **Personal use needs no review:** Settings → Roam Depot → developer mode → load the extension from
  a local folder. Caveat: local-folder developer extensions don't auto-start after reload, because
  folder permission needs a click. The legacy `{{[[roam/js]]}}` route also works but is discouraged.

### Prior art

- **None of the 217 Roam Depot extensions bridges to Obsidian, Logseq or local markdown folders.**
- **Existing tools are one-way migrations:** Obsidian's Importer (Roam JSON → vault), rj2obs and
  Roam2Obsidian.
- **Roam's own markdown import** gained folder import in Feb 2026. It copies files *into* the graph,
  which is the opposite of what we want.
- **Localhost access already ships in published extensions.** AnkiConnect (Fabricius), Ollama
  (Live AI, Roam Copilot) and local MCP gateways (Chief of Staff) all talk to localhost. Their only
  reported problem is CORS configuration.

### Platforms

| Platform | Support |
|---|---|
| Desktop app (Mac/Win/Linux) | Full support |
| Chrome/Edge on roamresearch.com | Full support, with one permission click per visit unless "Allow on every visit" is chosen |
| Firefox/Safari | Snapshot import only (no `showDirectoryPicker`) |
| Roam's native mobile app | **Will not run extensions at all**, per Roam |

---

## 3. The vault side: formats to support

### 3.1 What "Open Knowledge Format" means

There are two plausible candidates:

1. **Google Cloud's Open Knowledge Format (OKF)**, *most likely*. It was announced 2026-06-12 as v0.1;
   the current version is **v0.2** (Aug 2026). Spec: `GoogleCloudPlatform/open-knowledge-format/SPEC.md`.
   It formalizes Karpathy's "LLM Wiki" pattern: an agent-maintained markdown folder that people browse
   in Obsidian.
   - **Bundle:** a directory tree of `.md` files. Reserved `index.md` (a directory listing) and `log.md`
     (a dated change log) can appear at any level. The root `index.md` may carry `okf_version: "0.2"`.
   - **Concepts:** every other `.md` file is a "concept" whose ID is its path without `.md`.
   - **Frontmatter:** requires `type`; recommends `title`, `description`, `resource` and `tags`;
     optionally adds `sources[]`, `generated{by,at}`, `verified`, `status` (draft, stable or
     deprecated) and `stale_after`.
   - **Links:** *standard markdown links only*, bundle-absolute (`[x](/tables/customers.md)`) or relative.
     No wikilinks, aliases or block IDs in the spec. Real OKF tools such as the OpenKnowledge editor
     also understand `[[wikilinks]]`.
2. **"Obsidian-style vault" in general**: Obsidian Flavored Markdown plus JSON Canvas.

**Implication:** link resolution needs both paths. OKF uses deterministic path-based markdown links;
Obsidian uses name-based, case-insensitive wikilinks. Parse both kinds of link in every vault. Detect
the flavor per vault from markers: `.obsidian*/app.json`, `logseq/config.edn`, `dendron.yml`, an
`okf_version` in the root `index.md`, or `.ok/`. Allow a manual override. For OKF, use the `title`
frontmatter as the display and match name, and show `type`, `status` and verified/stale as badges.
Down-rank links from `index.md` and `log.md`, which are structural listings.

### 3.2 Obsidian link semantics that matter

- **Syntax:**
  - Links: `[[Note]]`, `[[Note|text]]` (and `[[Note\|text]]` inside tables), `[[Note#Heading#Sub]]`,
    `[[Note#^blockid]]`, `[[#Self heading]]`, `[[folder/Note]]` and `[[/root/Note]]`.
  - Embeds: `![[…]]` for notes, images, `pdf#page=3`, `.canvas` and `.base` files.
  - Markdown links: `[t](Note%20Name.md)` and `[t](<Note Name.md>)`. These go through **the same
    resolver as wikilinks**; they are *not* plain relative URLs.
- **Resolution:**
  - Matching is **case-insensitive** on the basename, with NFC normalization.
  - Partial paths match by suffix.
  - When several files share a basename, one in the source note's own folder wins. **Beyond that, the
    tie-break is undocumented.**
  - **Frontmatter `aliases` do NOT resolve links**; they only feed autocomplete and unlinked mentions.
- **What counts as a link:**
  - Links in `%%comments%%` **do** count.
  - Links in code, math, `<!-- -->` and canvas text cards do not.
  - Frontmatter links count **only when quoted** (`prop: "[[X]]"`).
  - Real vaults use them heavily: 64% of the links in kepano's popular vault template live in frontmatter.
- **Config that changes interpretation:**
  - `.obsidian/app.json`: `useMarkdownLinks`, `newLinkFormat`, `attachmentFolderPath`, and `userIgnoreFilters` (ignored files still resolve as targets).
  - `.obsidian/daily-notes.json`: `{folder, format}`. The format is moment.js style; the default is `YYYY-MM-DD`; it may contain `/`.
  - The config folder can be renamed to any dot-folder.
- **Dataview** `key:: value` fields use **the same syntax as Roam attributes** but are not links.
  Dataview query blocks produce links only at runtime, which we can't reproduce.
- **No readable index on disk.** Obsidian's own index lives in its IndexedDB, so we must parse files
  ourselves, or ask Obsidian through the REST API.

### 3.3 Other formats, cheaply addable later

| Format | Key quirks |
|---|---|
| Logseq (file graphs) | `pages/` and `journals/yyyy_MM_dd.md`. Namespace `/` is encoded as `___` or `%2F`. `title::` overrides the filename. Case-insensitive names. `alias::` *does* resolve. |
| Logseq (new DB version, 2026) | SQLite with only a one-way markdown mirror. Read-only or skip. |
| Foam | Case-insensitive suffix resolution. Don't double-count its link reference definitions. |
| Dendron | Dot hierarchy `a.b.c.md`. **Pipe order is reversed**: `[[label\|target]]`. Unmaintained. |
| Zettlr | Links can target 14-digit Zettelkasten IDs. Configurable pipe order. |

---

## 4. What an "association" is

For a Roam page **P**, there are five kinds of association, in order of usefulness.
"Counterpart" means the vault note that *is* P:

| # | Association | Source | Example |
|---|---|---|---|
| A | **Counterpart note**: a vault note that *is* P (same title/alias/path; see §5 tiers) | Matcher | Roam "Aliases" ↔ `Linking notes and files/Aliases.md` |
| B | **Vault backlinks**: notes linking to P's counterpart, *or* containing an unresolved `[[P]]`, including frontmatter properties | Index | kepano's `director: "[[Ridley Scott]]"` matches the Roam page "Ridley Scott" even though no "Ridley Scott.md" exists |
| C | **Tag mentions**: `#P` in the vault (a separate category, since Obsidian tags aren't links) | Index | `#project/alpha` ↔ Roam namespace "project/alpha" |
| D | **Bridges**: the counterpart's outgoing links, split into "also a Roam page" and "vault-only" | Index + Roam titles | Shows where the two graphs touch |
| E | **Weak suggestions**: loose or fuzzy name matches | Matcher | `🗂️ Plugins.md` ↔ "Plugins" |

Not included: **unlinked full-text mentions** of P's title in vault prose. That needs a full-text
index, roughly doubling memory. It could be a later, opt-in feature.

The reverse direction appears in the vault browser: for vault note N, show the Roam page that is its
counterpart plus that page's linked-reference count.

---

## 5. Matching Roam titles to vault notes: the hard part

### Where the two models disagree

| Aspect | Roam | Vault (Obsidian unless noted) | Handling |
|---|---|---|---|
| Case | Case-sensitive: "Apple" and "apple" can be different pages | Case-insensitive | Index lowercased + NFC. Rank exact-case first and badge case-only matches. |
| `/` | Just a character ("namespace" display) | A folder separator (Obsidian/OKF); `___` or `%2F` (Logseq); `.` (Dendron) | Roam "A/B" ↔ any path ending in `a/b.md` (strong). Never match the leaf "B" alone. |
| Daily notes | "November 5th, 2026" (uid `11-05-2026`) | `daily-notes.json` format (default `2026-11-05`, can be nested `2026/11/2026-11-05`); Logseq `2026_11_05` | Convert using `util.pageTitleToDate` + a small moment-format compiler (built in the prototype) |
| Illegal filename characters | Anything goes: `? : * " < > | # ^ [ ]` | Not in filenames; the Obsidian Importer strips them | A "sanitized" tier: "What is X?" ↔ `What is X.md` (medium confidence) |
| Aliases | No native alias (convention is an `Aliases::` attribute) | `aliases:` frontmatter (doesn't resolve links in Obsidian; does in Logseq) | Count as a strong counterpart match. Could also read Roam `Aliases::`. |
| `key:: value` | Attribute = a reference to page "key" | Dataview field (not a link) | Separate "attribute" category. Count `[[…]]` inside values as links. |
| Tags | `#x` ≡ `[[x]]` | Their own namespace, no spaces, case-insensitive | Separate category; match `space` ↔ `-`/`_` |
| Nested links | `[[[[Book]] by [[Author]]]]` is a valid title | Impossible as a filename | Strip brackets; low confidence |
| Block refs | `((9-char uid))` | `^blockid`, file-local | No general mapping. **But** the Obsidian Importer writes `roam-uid:` frontmatter and `^<roam-uid>` anchors, which give an *exact* mapping for vaults migrated from Roam. |

### Recommended confidence tiers (validated by the prototype)

1. **Exact**: basename after NFC. Strong.
2. **Case-insensitive**: basename. Strong; Obsidian itself resolves this way, and the help vault has 45 such links.
3. **Alias**: case-insensitive. Strong.
4. **Namespace path**: "A/B" ↔ `…/a/b.md`. Strong.
5. **Daily note**, via each vault's configured format. Strong.
6. **Sanitized**: illegal characters stripped, whitespace collapsed. Medium.
7. **Flattened namespace**: "A/B" ↔ `A-B`, `A_B`, `A∕B`. Weak, opt-in.
8. **Loose**: ignore punctuation, spaces and leading emoji. Suggestions only. It catches real
   conventions, but also false positives across languages.

In the prototype, real titles, case variants, aliases, unresolved targets, daily notes and namespaces
matched 100%; 100 random titles matched 0%.

`spike/src/core/ranker.ts` turns these tiers into a score in [0, 1] with strong (≥ 0.85), medium
(≥ 0.60) and weak bands, keeps every rule that fired as evidence, and flags near-ties as ambiguous.
It adds diacritic/quote/dash folding, emoji and ID-prefix stripping, Logseq `___` namespaces,
OKF `title:` frontmatter, and fuzzy suggestions (typos, word order) guarded against changed
digits, changed word count and whole-word substitutions. The scoring table is at the top of
that file.

**Ambiguity is real.** The Obsidian help repo has 331 duplicate basenames and the community hub 33;
the hub also has 17 case-only collisions (`Avatar.md` the theme vs `avatar.md` the person).
Index the whole multi-language help repo as one vault and naive tie-breaking sent **10,933 links
into the wrong language's folder**. A "longest shared folder prefix" tie-break cut that to 25.
The UI must show every candidate with an ambiguity badge rather than silently picking one, and
every folder containing `.obsidian/` should be treated as a separate vault root.

---

## 6. Performance (measured)

The prototype's browser-safe core parses, indexes and matches with zero runtime dependencies. It was
run in Node 22 and in headless Chrome 153, reading through the same `FileSystemHandle` API the
extension would use. Hardware: a 4-vCPU container.

| Vault | Notes | Links | Parse (CPU) | Index + matcher | Retained heap | Lookup "associations for P" | Re-index 1 changed file |
|---|---|---|---|---|---|---|---|
| obsidian-help (en) | 179 | 2.0k | 14 ms | 6 ms | 2 MB | ~5 µs | ~0.07 ms |
| obsidian-hub | 6.6k | 22.6k | 205 ms (Chrome) | 55 ms | 30 MB (Chrome) | ~3 µs | ~0.06 ms |
| synthetic | 20k | 201k | 413 ms (Chrome) | 453 ms | **97 MB** (Chrome) | ~6 µs | ~0.13 ms |
| synthetic | 50k | 505k | 1.3 s (Node) | 1.9 s | **270 MB** (Node) | ~11 µs | ~0.16 ms |

**Disk reads are the bottleneck.** Reads through Chrome's `FileSystemHandle` for 20k files:

| Read mode | Time |
|---|---|
| One file at a time | 16 s |
| 32 in parallel | 4.3 s |
| Metadata only (`getFile()` for size and mtime) | 1.3 s |

**Design consequences:**
- Run the scan in a Web Worker, which can receive directory handles.
- Cache parsed records in IndexedDB keyed by `(path, size, lastModified)`.
- Warm start = walk the folder + metadata check + rebuild the maps from the cache (about 2–3 s at 20k).
  Only changed files are re-read.
- Fetch context snippets lazily rather than storing them.
- Memory: about 500 bytes per link in the prototype's plain objects. A columnar or interned layout
  should cut that 2–3×, which is needed before supporting 50k+ notes comfortably.

A V8 pitfall found along the way: regex captures and `slice()` create "sliced strings" that keep the
whole file text alive. Copying and interning link targets cut retained heap from 237 MB to about
105 MB at 20k notes.

---

## 7. Proposed architecture

```
┌──────────────────────── Roam desktop renderer (https://roamresearch.com) ──────────────────────┐
│                                                                                                │
│  Roam Depot extension (TS, unminified build, uses window.React / Blueprint)                    │
│                                                                                                │
│   UI layer                                   Data layer                                        │
│   ─────────                                  ──────────                                        │
│   • "Vault references" panel, injected       • VaultRegistry: FileSystemDirectoryHandle per    │
│     beside Linked References (A–E above),      vault, stored in *device-local* IndexedDB       │
│     color-coded per vault, tiered            • Indexer Web Worker: walk → parse → VaultIndex   │
│   • Vault browser: full-page view via          (cache in IndexedDB by path+size+mtime;         │
│     mainWindow.registerComponent (tree,        FileSystemObserver → incremental updates)       │
│     search, rendered note, backlinks,        • RoamTitleSource: all :node/title via            │
│     "Roam counterpart")                        data.async.q, refreshed on :edit/time delta     │
│   • CSS badges on [[links]] that have        • Matcher: Roam titles × vault index → tiers      │
│     vault counterparts (generated stylesheet)                                                  │
│   • Context menus: page title / [[ref]] →                                                      │
│     "Open in vault", "Open in Obsidian"                                                        │
│     (obsidian://open?vault=…&file=…)                                                           │
│   • Command palette + optional graph-view                                                      │
│     nodes in a distinct color                                                                  │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
          │ File System Access API (no network, nothing written to the Roam graph)
          ▼
   ~/Vaults/Work/  ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Personal/  …
```

**Principles:**
- **Read-only.**
- **Vault content never enters the Roam graph.** Anything written to the graph syncs to Roam's cloud,
  so keeping it out matters for privacy and for encrypted graphs.
- **Vault configuration is per device** (paths differ between machines). Only non-sensitive
  preferences go in synced extension settings.

---

## 8. Risks and issues, ranked

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Persistent folder access relies on Roam desktop's undocumented permission setup.** If Roam adds a deny-by-default handler, File System Access stops working. | High (low likelihood) | Test first (§9). Keep the snapshot-import fallback. A companion process is the last resort. |
| 2 | **No supported UI injection point.** A Roam front-end change can break the panel. | High | Follow the proven patterns (`.rm-reference-main`, `.rm-title-display`), guard with `data-*` attributes, fall back to a floating panel, and keep the vault browser on the official `registerComponent`. |
| 3 | **Matching false positives/negatives** (case, `/`, illegal characters, ambiguous basenames, aliases) | High (product quality) | Confidence tiers, ambiguity badges, per-vault flavor detection, and user-confirmable manual mappings stored locally. |
| 4 | **Cold-scan time and memory on large vaults** (≈4–16 s and ≈100 MB at 20k notes) | Medium | Worker, IndexedDB cache, lazy snippets, compact data layout; show progress in the UI. |
| 5 | **Depot review**: file-system access, a Blob Web Worker, unminified build | Medium | No network, zero runtime dependencies, clear disclosure; main-thread chunking fallback; or stay personal via developer mode. |
| 6 | **Blocked folders** (home, Documents or Desktop *root*, `~/Library` except iCloud) | Medium | Clear picker guidance; detect a failed pick. |
| 7 | **Rendering fidelity in the vault browser.** Callouts, embeds and images are doable. Dataview, Canvas, Bases and Excalidraw are partial or absent. | Medium | Render with `@quartz-community/remark-obsidian`-style parsing plus a link out to Obsidian for the rest. |
| 8 | **Sync artifacts**: iCloud/Dropbox placeholder files, conflict copies, half-written files | Medium | Tolerate read errors, debounce watcher events, flag `conflicted copy` names. |
| 9 | **Chromium only.** No Firefox/Safari folder access; native mobile runs no extensions. | Low (desktop is the target) | Snapshot import elsewhere. |
| 10 | **Settings sync / admin lock**: extension settings live in the graph and may be locked by an admin | Low | Keep vault config in IndexedDB. |
| 11 | **Linux `LANG=C`**: Chrome's file APIs failed every non-ASCII filename in our C-locale sandbox | Low | Document it; surface per-file read errors. |
| 12 | **Young dependencies**: OKF (v0.2) and `remark-obsidian` (July 2026) | Low | Pin versions; the hand-rolled tokenizer is the baseline. |

Side finding for Roam (not our problem): the desktop app's `update-pages` IPC joins graph name and
uid into a file path without validating them. It is a write path that only an admin-configured
setting enables, but it may be worth reporting to Roam.

---

## 9. Validate first: a one-day in-app spike

These are the assumptions that only the real Roam desktop app can confirm. Do this before any UI work:

1. **Persistent access.** Load a minimal developer-mode extension. Call `showDirectoryPicker()`, store
   the handle in IndexedDB, quit and relaunch Roam, then call `queryPermission({mode:'read'})`.
   - Expect `"granted"` with no click.
   - If it shows `"prompt"`, try `requestPermission()` from a button: expect it to be granted without a dialog.
2. **Observer.** `new FileSystemObserver(cb).observe(handle, {recursive:true})` fires on edits made in Obsidian.
3. **Restricted folders.** Check what happens when picking `~/Documents` itself.
4. **Panel injection.** Mount a panel above `.rm-reference-main` and check it survives navigation,
   the sidebar, zooming into blocks, and the daily-notes log.
5. **Worker.** A `new Worker(URL.createObjectURL(new Blob([code])))` runs and can receive a directory handle.
6. **Scan time.** Cold-scan your largest real vault.

## 10. Suggested roadmap

| Phase | Scope |
|---|---|
| 0 | §9 in-app spike (developer mode) |
| 1 (MVP) | One Obsidian vault. Worker indexer with cache and watcher. "Vault references" panel showing A, B and C with tiers 1–5. "Open in Obsidian". A simple read-only note viewer. |
| 2 | Multiple vaults with per-vault colors. Full-page vault browser. Link badges. Context menus. Daily notes. Ambiguity UI and manual mapping. |
| 3 | OKF and Logseq flavors. Graph-view integration. Optional Obsidian REST API source. Memory compaction for 50k+ notes. Depot submission. |

---

## Appendix: evidence and sources

**Roam desktop app internals:** desktop v0.0.42 from the official update feed, unpacked and read
without running it:
- `background.js` lines 57555–57582 (window), 61059 and 61089 (permission handler).
- `preload.js` lines 25–53.

**Electron and Chromium source:**
- `electron/electron@v43.8.0`: `shell/browser/file_system_access/file_system_access_permission_context.cc` (`GetStatus`), `shell/browser/electron_permission_manager.cc`, `shell/browser/feature_list.cc`.
- `chromium@150.0.7871.250`: `chrome_file_system_access_permission_context.cc` (blocklist), `runtime_enabled_features.json5` (`FileSystemObserver`: stable).

**Roam:**
- Developer docs (mirror): https://roamdocs.fyi/developer-documentation/llms-full.txt
- Roam Depot: https://github.com/Roam-Research/roam-depot
- Depot review threads: PRs #29, #74, #92, #321, #1500.

**Obsidian:**
- Help vault: https://github.com/obsidianmd/obsidian-help (Internal links, Aliases, Properties, Embed files, Obsidian URI, Configuration folder).
- API: https://github.com/obsidianmd/obsidian-api
- Importer, Roam format: https://github.com/obsidianmd/obsidian-importer
- Local REST API: https://github.com/coddingtonbear/obsidian-local-rest-api

**OKF:**
- Spec: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md
- Announcement: https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing

**Other formats:**
- Logseq filename format: https://github.com/logseq/docs/blob/master/pages/Filename%20format.md
- Foam: https://docs.foam.md/features/wikilinks/
- Dendron: https://wiki.dendron.so

**Chrome:**
- Local Network Access: https://developer.chrome.com/blog/local-network-access
- Persistent file-system permissions: https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api

**Prototype:** [`spike/`](../spike). Its README has run instructions.
