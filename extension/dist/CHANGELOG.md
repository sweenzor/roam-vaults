# Changelog

## 0.1.0 (2026-11-09)

First release of Vaults: see notes from your Obsidian-style vaults in your Roam graph.

- Adds an **External Vault References** section below Linked and Unlinked References on every page,
  styled like them. It appears once a vault is connected.
- Shows the vault note that is this page (same name, any case, alias, folder path or daily note), notes
  that link here, and notes tagged here.
- Supports several vaults in one section, with the vault name before each title.
- Unfold the matching note in place, or open any note in a read-only viewer that follows links.
- **Open in Obsidian** button in the note viewer.
- Updates live when notes change, and caches parsed notes so later starts are fast.
- Manage vaults in Settings → Roam Depot → External Vault References: add, remove, reconnect and rescan.
  No command palette commands.
- Read-only, with no network requests.
