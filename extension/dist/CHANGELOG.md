# Changelog

## 0.3.0 (unreleased)

- The README has a section and a picture, taken in real Roam, for embeds and block links, property pages,
  OKF bundles, and the section's search and filter.

- External Vault References are drawn like Roam's Linked References. A line that links to the page is a
  Roam block with the headings and list items it sits under as a path above it; click a part of the path
  to open it in place, and click a line's caret to show the items nested under it. A note unfolded on the
  page or opened in the viewer is an outline: headings, nested lists and paragraphs are blocks, and
  frontmatter properties are attributes.
- Links, tags, aliases, bold, italics, highlights, strikethrough, to-do boxes and attributes are drawn as
  Roam draws them, including Roam's own `{{[[TODO]]}}`, `^^highlight^^` and `Name::` from a Markdown export.
  `[[` `]]` show or hide with your own Roam setting.
- A link opens its page in Roam, shift-click opens it in the sidebar, and ctrl-shift-click opens its
  linked references there, as in Roam. A link to a note without a page opens the note.
- A click on a line's text no longer opens the note: the bullet and the note title do, as a bullet and a
  page title do in Roam. The section folds from its caret.
- Note titles show their folders in grey before the note's name.
- A paragraph wrapped over several lines in the file is one block, not one block per line.
- Obsidian's `%%comments%%` and block ids (`^a1b2c3`) are hidden, as in Obsidian's reading view. Tasks
  with a custom status (`[/]`, `[-]`, `[?]`, `[!]`) are drawn as ticked boxes, as Obsidian draws them.
- OKF bundles: a note is found by its frontmatter `title` as well as its file name, a folder's
  `index.md` is the note for the page named like the folder, and each day of a `log.md` is a reference on
  that day's daily page. A page called Index or Log no longer lists every folder's `index.md` or `log.md`.
- A heading that links to the page comes with what is under it, behind its caret.
- A link to a block of a note (`[[Note#^id]]`) is a Roam block reference: it shows the block's text, and a
  click opens the note at that block. A link to a heading (`[[Note#Heading]]`, `[text](Note.md#heading)`)
  reads "Note > Heading" and opens the note at the heading.
- Embeds are drawn in place, as Roam draws `{{embed}}`. An embedded block or heading (`![[Note#^id]]`,
  `![[Note#Heading]]`) shows that block with what is under it. An embedded note (`![[Note]]`) shows its
  title, and the bar at its left opens it, as a page embed does in Roam.
- Pictures kept in the vault (`![[photo.png]]`, `![[photo.png|300]]`, `![alt](photos/photo.png)`) show
  inline. They are read from the folder on your device and go nowhere else.
- Properties read as Roam attributes: YAML's quotes are gone, tags are tags, a list on one line is its
  values, and a date (`created: 2026-11-09`) is a link to that day. The day's page in Roam lists the note.
- A property whose value is a path to a note (OKF's `superseded_by`, `sources[].resource`) links to that
  note, and the note's page lists it.
- A property that links to the page is drawn as its attribute block (`related:: [[Page]]`).
- Markdown tables are drawn as Roam's tables, and numbered lists keep their numbers, drawn where Roam
  draws them for a numbered list.
- The index is built again by the first scan after this update.
- Frontmatter `tags` written as one string with commas or spaces (`tags: a, b`) no longer make tags.
  Obsidian reads tags from a list (`tags: [a, b]`), and Vaults now does the same.
- A note opens in Roam's main window, drawn as a page: its name as the title and its outline under it. Back
  and Forward work as they do between pages. Shift-click opens it over the page instead (Roam's sidebar
  takes no windows from an extension).
- OKF bundles are found by the `okf_version` in their `index.md`. In a bundle a note is named by its
  `title`, `type` and `status` are page references (the page **Metric** lists the notes of that type),
  and a link is read from the note's own folder first and, when it starts with `/`, from the bundle's.
- A property's name is a page, as an attribute's name is in Roam: the page **author** lists every note
  with an `author` property, and a `Name::` written in a note (as Roam's Markdown export writes one)
  counts the same. Tags, aliases and `cssclasses` are left out: they are Roam's tags and aliases.
- Footnotes are Roam block references: `[^1]` shows the footnote's text and opens the note at it, the
  footnote is a block of its own, and an inline footnote `^[text]` shows its text.
- Reference-style Markdown links (`[text][ref]`, `[ref]: target.md`) are links: they count on the
  page they name and are drawn as the link they stand for, with the lines that define them hidden.
- The section's header has Linked References' search box and filter. A search shows the references
  whose block or path has the words, written as they are in the note with the words in yellow, as Roam
  shows them. The filter lists the pages the references link to; click one to keep only the references
  that link to it, shift-click to hide them. The count reads "1 of 3 external vault references" meanwhile.

## 0.2.0 (2026-11-22)

- Notes with a similar name. When no note is the page, External Vault References also lists notes whose
  name or alias is close to the page title: a typo, two swapped letters, a plural, or the same words in
  another order. They come last, faded, with the letters that differ highlighted in Roam's highlight
  colour. Every word must start with the same letter and keep its numbers, and titles under five letters
  get none, so `Q3 Plan` never matches `Q4 Plan` and `Might` never matches `Eight`.
- The vault index is kept in a database on disk (SQLite, in the Roam app's storage on this computer)
  instead of in memory, so a large vault takes much less memory while Roam is open. A first scan takes
  longer. The index is built again by the first scan after this update. Removing a vault deletes its
  database.
- **Reference counts**, a new switch in Settings → Roam Depot → Vaults, off until you turn it on. It adds
  a line under the page title that shows how many Linked, Unlinked and External Vault References the page
  has, in that order, so you can see what's further down without scrolling. Click a count to jump to that
  section. Counts of zero are left out, and nothing shows while no vault is connected.
- A page with thousands of vault notes to list (one named like a common tag, for example) no longer
  holds Roam up while they are all drawn. The first notes are drawn, and the rest as the page is scrolled.
- Scanning a large vault uses much less memory at its peak, on Rescan most of all. The files are walked
  and read in a helper that exists only for the scan, so the file handles a scan makes are given back as
  it goes instead of piling up next to the index.
- Pages show their vault notes sooner: the lines of linking notes are read for the notes that are drawn,
  and for the rest as the page is scrolled, instead of for up to 200 notes at once.
- A vault open in a second Roam window or tab is not read a second time. That window shows what the
  first one has, follows its changes, and takes the vault over when the first one closes.
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
