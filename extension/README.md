<div align="center">

# Vaults

See notes from your Obsidian-style vaults in your Roam graph.

![External Vault References on a Roam page, listing notes from two vaults](https://raw.githubusercontent.com/sweenzor/roam-vaults/84a778cb7e5a0007230ee99702fdffbc369a6c95/docs/images/one-section.png)

</div>

Vaults adds an **External Vault References** section to every Roam page. It sits below Linked and
Unlinked References and looks like them. It lists the notes in your Obsidian-style vaults, meaning local
folders of Markdown notes, that are about the page you're on or link to it.

It only reads your vault. Nothing from the vault is written to your Roam graph, and nothing is sent over the
network.

<details>
<summary><b>What's an Obsidian-style vault?</b></summary>

A vault is just a folder of Markdown (`.md`) files on your computer, with subfolders, that link to each
other. [Obsidian](https://obsidian.md) made the idea popular. See
[How Obsidian stores data](https://help.obsidian.md/data-storage) for what a vault is, and
[Internal links](https://help.obsidian.md/links) and
[Obsidian Flavored Markdown](https://help.obsidian.md/obsidian-flavored-markdown) for the link and tag
syntax Vaults understands. You don't need Obsidian installed: any folder of Markdown notes works.

That includes **Open Knowledge Format (OKF)** bundles. [OKF](https://github.com/GoogleCloudPlatform/open-knowledge-format)
is an open format from Google Cloud for knowledge kept as plain Markdown files with YAML frontmatter
([spec](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)). OKF uses standard
Markdown links, including bundle-absolute ones like `[Customers](/tables/customers.md)`, and Vaults follows
those as well as `[[wikilinks]]`.

</details>

## What it shows

One section covers every vault you add, and its count is the total across vaults. Notes are titled by
their path in the vault, such as `Projects/Kernel meeting protocol`. With more than one vault, the vault
name comes first in grey, such as `work-vault/Projects/Kernel meeting protocol`. The section lists three
kinds of notes, in this order:

- **The note that is this page**, listed first and folded. A note matches when it has the same name (in any
  letter case), lists the page title as an alias, sits at the same folder path (Roam `A/B` and `A/B.md`), or
  is the daily note for the same date. If several notes match, they're all shown. Click the caret to unfold
  the note and read it in place.
- **Notes that link here.** These are notes that link to the matching note, or contain `[[This Page]]` even
  when no such note exists. Links in frontmatter count too. Each linking line is shown like a Roam block.
- **Notes tagged here.** These are notes tagged `#this-page`, shown with the tag. A Roam namespace `a/b`
  matches the nested tag `#a/b`.

![The matching note, work-vault/Planning, unfolded in place](https://raw.githubusercontent.com/sweenzor/roam-vaults/84a778cb7e5a0007230ee99702fdffbc369a6c95/docs/images/unfolded-note.png)

Click a note title or line to read the whole note in Roam. Links between notes work inside the viewer.
If you use Obsidian, click **Open in Obsidian** in the viewer to jump to the note there. To use another
editor, see [Opening notes in another editor](#opening-notes-in-another-editor).

![The note viewer, with an Open in Obsidian button](https://raw.githubusercontent.com/sweenzor/roam-vaults/84a778cb7e5a0007230ee99702fdffbc369a6c95/docs/images/note-viewer.png)

The section updates by itself. When you edit a note in Obsidian or any other editor, the change shows up in Roam within about a
second.

## Requirements

- **Roam desktop app** (tested on macOS and Linux). Roam in Chrome or Edge should also work, but the browser asks you to
  allow folder access again on each visit unless you choose "Allow on every visit". Other browsers and
  Roam's mobile apps can't read local folders (see [Mobile](#mobile)).
- A folder of Markdown (`.md`) files, such as an Obsidian vault or an OKF bundle. Obsidian vaults work
  best: daily-note formats, aliases and tags are read the way Obsidian reads them.

## Getting started

1. Install **Vaults** from Roam Depot.
2. Open **Settings → Roam Depot → Vaults**.
3. Click **Add vault folder**, choose your vault folder, and allow access when asked.

Matching notes then show up below Linked References, as **"External Vault References"**. The
section appears only on pages that have matching vault notes. Other pages look exactly as before. The first
scan of a large vault takes a few seconds. After that, only changed files are read again.

Choose the vault folder itself, such as `Documents/My Vault`, not a folder above it like `Documents` or
your home folder. You can't type a folder path: Roam can only read a folder you pick in the system's
folder dialog.

### Managing vaults

Everything is in **Settings → Roam Depot → Vaults**:

- **Add vault folder** adds another vault. Notes from all your vaults appear in the same section on each
  page, each title starting with its vault's name.
- Each vault shows its status here, such as its note count, "Indexing" or "Needs permission again".
  The page itself never shows indexing or permission notices.
- **Remove** forgets that vault on this computer and deletes its cache. Your files aren't touched.
- **Reconnect** appears when Roam needs your permission again to read a vault.
- **"Last scan didn't finish"** means Roam crashed while reading that vault. It isn't read again until
  you click **Rescan** in its row (see [Troubleshooting](#troubleshooting)).
- **Rescan** reads every vault again, except one whose last scan didn't finish. Only changed files are parsed.
- **Reference counts** turns on the line of counts under each page title (see below). It's off until you turn it on.

Vaults adds no commands to the command palette.

### Reference counts

On a page with a lot of references, the vault notes are far down. Turn on **Reference counts** in
**Settings → Roam Depot → Vaults** to see, under each page title, how many Linked, Unlinked and External Vault
References the page has. Click a count to jump to that section.

![Reference counts under a page title: 15 Linked References, 191 Unlinked References, 3 External Vault References](https://raw.githubusercontent.com/sweenzor/roam-vaults/49ac8d0dc199e975fc3474fc95013113f6898dd4/docs/images/reference-counts.png)

A count of zero is left out. Unlinked references are counted the way Roam counts them when you open that
section: blocks that mention the page's title without linking to it.

## Troubleshooting

<details>
<summary><b>Roam can't open the folder I picked</b></summary>

macOS protects `Documents`, `Desktop`, `Downloads` and your home folder, and Roam can't open them
directly. Choose the vault folder inside them instead, such as `Documents/My Vault`. If Roam already
refused a folder, quit and reopen Roam before you try again.

</details>

<details>
<summary><b>A vault says "Needs permission again"</b></summary>

Roam needs you to allow access to that folder again. Click **Reconnect** in its row and allow access. In Chrome or Edge, choose "Allow on every
visit" so the browser doesn't ask each time.

</details>

<details>
<summary><b>A vault says "Last scan didn't finish"</b></summary>

Roam crashed while reading that vault, for example because it ran out of memory on a very large folder.
So that Roam stays usable, the vault isn't read again on start until you click the **Rescan** in its
row. If it keeps happening, remove the vault or choose a smaller folder.

</details>

<details>
<summary><b>A note I expect isn't listed</b></summary>

Check that it matches one of the rules in [What it shows](#what-it-shows): same name, an alias, the
same folder path, the same daily-note date, a `[[link]]` or a `#tag`. Similar titles aren't matched
yet. Only `.md` files are read. If you just changed the note and it doesn't show yet, click **Rescan**.

</details>

### Opening notes in another editor

The viewer's button opens notes in Obsidian. To open them in another editor instead, fill in **Open notes
with** in **Settings → Roam Depot → Vaults** with the link your editor uses to open a file. Put `{vault}`
where the vault folder's name goes and `{file}` where the note's path inside the vault goes. The button then
reads **Open in editor**. Leave the field empty to go back to Obsidian.

Roam can't tell the extension where your vault folder is on disk, so type the folder that holds your vaults
yourself. For vaults in `/Users/you/Notes`:

| Editor | Open notes with |
| --- | --- |
| VS Code | `vscode://file/Users/you/Notes/{vault}/{file}` |
| Cursor | `cursor://file/Users/you/Notes/{vault}/{file}` |
| Zed | `zed://file/Users/you/Notes/{vault}/{file}` |
| BBEdit | `x-bbedit://open?url=file:///Users/you/Notes/{vault}/{file}` |

The setting applies to every vault, so this works when your vaults sit in the same folder.

## Privacy

- **Read-only.** The extension reads your vault folder and never changes it. It never writes vault content
  into your Roam graph.
- **Stays on this computer.** The extension makes no network requests. Your vault folder, and the cache of
  parsed notes that makes later starts fast, are kept in the Roam app's storage on this computer. They aren't
  stored in your graph and don't sync to your other devices or to other people in a shared graph.
- **Folder access you control.** The extension can only read folders you choose. Removing a vault deletes
  its saved folder access and its cache of parsed notes.
- **Who sees the section.** The section is drawn on your screen only. Collaborators on a shared graph don't
  see your vault unless they install the extension and add a vault themselves.

## Mobile

Roam's mobile apps can't read folders on your phone, so External Vault References doesn't show on mobile in
this version.

<details>
<summary><b>A possible mobile snapshot, and its privacy tradeoff</b></summary>

A later version may add an opt-in **mobile snapshot**. Your desktop would upload a copy of the vault index
into your graph's file storage, and your phone would read that copy. It will be off unless you turn it on.
Before you turn it on, know this: Roam's file links aren't private. **Anyone who has the snapshot's link can
download it without signing in to Roam.** The link is hard to guess, but it's stored in your graph, so anyone
who can read your graph can find it, and you can't revoke a copy someone has already downloaded. Don't use the
snapshot for a vault you wouldn't want shared that way.

</details>

## Limits in this version

- Matching uses the exact rules above. Fuzzy or "similar title" matches aren't shown yet.
- Notes are shown as read-only previews. Edit them in Obsidian or your usual editor.
- Only `.md` files are read. Canvas files, PDFs and attachments are skipped.
- Files and folders your vault's `.gitignore` files ignore, or that Obsidian's **Excluded files** setting
  lists, are skipped. So are folders whose name starts with a dot, such as `.obsidian` and `.trash`.

## Feedback and source

Report problems or ideas at [github.com/sweenzor/roam-vaults/issues](https://github.com/sweenzor/roam-vaults/issues).
The source code, design notes and changelog are at
[github.com/sweenzor/roam-vaults](https://github.com/sweenzor/roam-vaults).
