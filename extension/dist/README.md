# Roam Vaults

See your Obsidian notes next to your Roam pages. Roam Vaults adds a **Vault references** section
above Linked References on every Roam page. It lists:

- **This page in the vault:** the vault note that is this page. A match can be the same name, the same
  name in different case, an alias, a folder path (Roam `A/B` ↔ `A/B.md`) or a daily note. If more than one
  note matches, all of them are shown.
- **Linked from the vault:** vault notes that link to that note, or contain `[[This Page]]` even when no
  such note exists. Frontmatter links count too. Each one shows the line with the link.
- **Tagged in the vault:** notes tagged `#this-page`. A Roam namespace `a/b` matches the nested tag `#a/b`.

Click a note to read it in Roam. Use **Open in Obsidian** to jump to it there.

It's read-only. Nothing from the vault is written to your Roam graph, and it makes no network requests.
The vault folder is remembered on this device only.

## Install (developer mode)

1. Run `npm install && npm run build`, or use a prebuilt `dist/` folder.
2. In Roam desktop, go to **Settings → Roam Depot**. Turn on developer mode from the gear menu.
3. Under **Developer Extensions**, click the folder icon and choose the `dist` folder.
4. Open the command palette (Cmd/Ctrl+P) and run **Vault: Choose vault folder**. You can also click
   **Choose vault folder** in the Vault references section of any page.

Choose the vault folder itself, for example `Documents/My Vault`. Don't pick `Documents`, `Desktop` or
your home folder: macOS protects those, and Roam silently fails to open them. If that happens, Roam Vaults
tells you, and you need to quit and reopen Roam before trying again.

## Commands

| Command | What it does |
|---|---|
| Vault: Choose vault folder | Connect a vault (replaces the current one) |
| Vault: Rescan vault | Re-read the vault (only changed files are parsed) |
| Vault: Disconnect vault | Forget the vault on this device |

## How it works

- A Web Worker walks the vault, parses every `.md` file and builds a link index. Parsed notes are cached in
  IndexedDB by path, size and modification time, so later starts only re-read changed files.
- `FileSystemObserver` watches the folder, so edits made in Obsidian show up within a second.
- Daily notes use the format in `.obsidian/daily-notes.json`, falling back to `YYYY-MM-DD`.

The design and measurements are in [`../docs/FEASIBILITY.md`](../docs/FEASIBILITY.md).

## Develop

```bash
npm install
npm test          # engine and parser tests (Node 22+)
npm run typecheck
npm run build     # writes dist/extension.js
```
