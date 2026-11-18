# Changelog

## Unreleased

- A page with thousands of vault notes to list (one named like a common tag, for example) no longer
  holds Roam up while they are all drawn. The first notes are drawn, and the rest as the page is scrolled.
- Scanning a large vault uses much less memory at its peak, on Rescan most of all. The files are walked
  and read in a helper that exists only for the scan, so the file handles a scan makes are given back as
  it goes instead of piling up next to the index.
- A first scan is faster: each note is looked up on disk once instead of twice.
- After Roam starts, pages show their vault notes as soon as the saved index is loaded, instead of after
  every file in the vault has been checked. The check then runs in the background and settings show its
  progress.
- Rescan, and the check at start, change the index in place instead of building a second one beside it,
  so pages keep their vault notes while it runs and it needs less memory.
- While a vault is scanned, its row in settings shows a progress bar above the status. A vault that was
  scanned before fills the bar by the notes counted. A first scan has no total to count towards, so its bar
  is striped until the scan is done.

## 0.1.1 (2026-11-17)

Uses much less memory, most of all with large vaults.

- The extension no longer keeps a file handle open for every note. Each one cost memory in Roam's main
  process as well as in the page.
- Scanning a vault, at start and on Rescan, no longer piles up file handles until the browser gets round
  to freeing them, which was the largest spike.
- The link index is several times smaller: it keeps each link's target and line instead of an object per
  link, and resolves links when a page asks for them.
- The cache of parsed notes is stored one note at a time, so an edit writes one small record instead of
  rewriting the whole vault's cache, and a rescan no longer reloads it. The first start after updating
  reads every note once to build the new cache.
- Note text kept for the lines under a page is capped at about a megabyte, and page results at the 50
  most recently viewed pages per vault.
- Pages are no longer redrawn for every progress step of a scan.
- If Roam crashes while reading a vault (for example out of memory on a very large folder), that vault
  isn't read again on every start, which crashed Roam again each time. Its status in settings reads
  "Last scan didn't finish", with a Rescan button to try again.
- Only one scan of a vault runs at a time. Clicking Rescan while one is running queues a single scan
  after it, instead of starting another alongside it with its own copy of the index.
- Notes with the same title are listed in a fixed order, by path.
- Clicking a line under External Vault References opens the note at the top, with that line still
  highlighted, instead of scrolled to the middle of the note.
- In the note viewer, the title and file path no longer get squeezed on long notes, where the scrolled
  text ran underneath the path.
- A folder created, deleted, moved or renamed inside a vault no longer rescans the whole vault. Only that
  folder is read, and a moved folder's notes aren't read again. Vaults that tools write new folders into
  all day stay cheap to watch ([#8](https://github.com/sweenzor/roam-vaults/issues/8)).
- A note or folder moved into a hidden folder such as `.trash` now disappears from the page right away.
- Files and folders ignored by the vault's `.gitignore` files (the top one and any in subfolders), or
  listed in Obsidian's Excluded files (Settings → Files and links), are no longer indexed. Ignored folders
  aren't read at all, and changes inside them no longer set off a rescan. Editing a `.gitignore` or the
  Excluded files list rescans the vault.
- New **Open notes with** setting: open notes from the viewer in VS Code, Cursor, Zed or another editor
  instead of Obsidian, using a link with `{vault}` and `{file}` in it. Empty keeps Open in Obsidian.

## 0.1.0 (2026-11-09)

First release of Vaults: see notes from your Obsidian-style vaults in your Roam graph.

- Adds an **External Vault References** section below Linked and Unlinked References on every page,
  styled like them. It appears only on pages with matching vault notes, and adds no notices or messages to the page.
- Shows the vault note that is this page (same name, any case, alias, folder path or daily note), notes
  that link here, and notes tagged here.
- Supports several vaults in one section, with the vault name before each title.
- Unfold the matching note in place, or open any note in a read-only viewer that follows links.
- **Open in Obsidian** button in the note viewer.
- Updates live when notes change, and caches parsed notes so later starts are fast.
- Manage vaults in Settings → Roam Depot → Vaults: add, remove, reconnect and rescan.
  No command palette commands.
- Read-only, with no network requests.
