# Developing Vaults

The user-facing guide is [README.md](README.md). Roam Depot shows that file inside Roam, so keep
developer notes here.

## Build and test

```bash
npm install
npm test             # engine and parser tests (Node 22+)
npm run typecheck
npm run build        # writes dist/extension.js and copies README.md and CHANGELOG.md into dist/
npm run test:browser # builds, then runs a headless browser smoke test
```

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
- Parsed notes are cached in IndexedDB by path, size and modification time, so later starts only re-read
  changed files. Removing a vault deletes its cache.
- Folder handles are kept in this device's IndexedDB, never in Roam settings, which sync through the graph.
- `FileSystemObserver` watches the folder, so edits made in Obsidian show up within a second.
- Daily notes use the format in `.obsidian/daily-notes.json`, falling back to `YYYY-MM-DD`.
- CSS classes are prefixed `rv-`, and every DOM node the extension adds carries a data attribute, so
  `onunload` can remove all of them.

The design and measurements are in [docs/FEASIBILITY.md](../docs/FEASIBILITY.md).
