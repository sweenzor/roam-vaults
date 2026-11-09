# Roam Vaults

See your Obsidian notes next to your Roam pages. Roam Vaults adds an **External Vault References** section
below Linked and Unlinked References on every Roam page, styled like them. Each vault you add gets its own
section, and each section lists notes from that vault, titled by their path in the vault (`Projects/Kernel meeting protocol`):

- **The note that is this page**, listed first and folded. A match can be the same name, the same name in different
  case, an alias, a folder path (Roam `A/B` ↔ `A/B.md`) or a daily note. If more than one note matches, all of
  them are shown. Click the caret to unfold the note and read it right there.
- **Notes that link here:** notes that link to that note, or contain `[[This Page]]` even when no such note
  exists. Frontmatter links count too. Each linking line is shown like a Roam block.
- **Notes tagged here:** notes tagged `#this-page`, shown with the tag. A Roam namespace `a/b` matches the
  nested tag `#a/b`.

Click a note title or line to read the note in Roam. The note viewer has an **Open in Obsidian** button to jump to it there.

It's read-only. Nothing from a vault is written to your Roam graph, and it makes no network requests.
The vault folders are remembered on this device only.

## Install (developer mode)

1. Run `npm install && npm run build`, or use a prebuilt `dist/` folder.
2. In Roam desktop, go to **Settings → Roam Depot**. Turn on developer mode from the gear menu.
3. Under **Developer Extensions**, click the folder icon and choose the `dist` folder.
4. Open the command palette (Cmd/Ctrl+P) and run **External Vault References: Add vault folder**. You can
   also click **Add vault folder** in the External Vault References section of any page. Run it again to add
   more vaults.

Choose the vault folder itself, for example `Documents/My Vault`. Don't pick `Documents`, `Desktop` or
your home folder: macOS protects those, and Roam silently fails to open them. If that happens, Roam Vaults
tells you, and you need to quit and reopen Roam before trying again.

## Commands

| Command | What it does |
|---|---|
| External Vault References: Add vault folder | Add a vault. Each vault gets its own section |
| External Vault References: Rescan vaults | Re-read every vault (only changed files are parsed) |
| External Vault References: Remove all vaults | Forget every vault on this device |

To remove one vault, hover its section header and click **Remove**. The folder itself is untouched.

## How it works

- Each vault has its own Web Worker. It walks the vault, parses every `.md` file and builds a link index. Parsed notes are cached in
  IndexedDB by path, size and modification time, so later starts only re-read changed files.
  Removing a vault deletes its cache.
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
