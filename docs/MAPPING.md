# Mapping Obsidian and OKF to Roam

Vaults is a mapping between a Roam graph and a folder of Markdown files, written either the way
Obsidian writes them or as an [OKF](https://github.com/open-knowledge-format/open-knowledge-format)
bundle. This page lists every concept on the file side, the closest thing Roam has, what Vaults does
with it today, and what is left. It is the reference for deciding what to build next.

The rule throughout: where Roam has the concept, draw it and make it act the way Roam does. Where
Roam has none, leave it out rather than invent UI.

## How this was measured (2026-11-22)

- **Obsidian 1.15.1**, run on Linux and driven through its developer tools, with a made-up vault of
  15 notes, a canvas, a base, an image and a PDF. The Obsidian column is what the app did.
- **OKF v0.3**, read from the spec and tried with a made-up bundle. The GoogleCloudPlatform
  repository was deprecated on 2026-11-18 in favour of the one linked above.
- **Roam 0.13.14**, measured in the public help graph: Linked References, clicks and modifiers, and
  the Markdown export. Block references, embeds, inline images, tables and numbered lists are measured too.
- **Today** is the extension's source as of the pull request that added this page.

## Obsidian

| Obsidian | What Obsidian does | Roam equivalent | Today | Gap |
| --- | --- | --- | --- | --- |
| Note | The file name is the name, in any letter case | Page title | Matched by name, case, alias and path | None |
| Folder | Only tells same-named notes apart | Namespace `A/B` | Grey folder prefix on the title; page `A/B` matches `A/B.md` | None |
| Same name twice | The note in the linker's own folder wins | Titles are unique | Same folder, then shallowest, shortest, alphabetical | None seen |
| Alias | Does not resolve links. Shows in the `[[` suggester, the switcher and unlinked mentions | No native alias | A page named like an alias shows the note | None |
| Daily note | Folder and date format from `daily-notes.json` | Daily page | Daily page matches the daily note; the format is read. A date in a property is a reference on that day's page | None |
| Wikilink | Opens the note in the same tab | Page reference | Roam's element; click opens the page, shift-click the sidebar | None |
| Link with text `[[A\|b]]`, `[b](A.md)` | Shows `b` | Alias `[b]([[A]])` | Roam's alias element | None |
| Heading link `[[A#H]]` | Shows "A > H", scrolls to the heading | Reference to the heading block | Reads "A > H"; a click opens the note with the heading marked | None |
| Block id `^id`, `[[A#^id]]` | The id is hidden; the link opens and flashes the block | Block reference `((uid))` | `^id` is hidden; the link is Roam's block reference with the block's text, and a click opens the note at that block | None |
| Embed `![[A]]`, `![[A#H]]`, `![[A#^id]]` | The note, section or block drawn in place | `{{embed}}` | Roam's embed elements: a block or heading with what is under it; a note as its title, opened from the bar at its left. Three levels deep | None |
| Image and PDF embed | Image with a width; PDF viewer | Inline image; `{{pdf}}` | Images show inline, read from the folder, with Obsidian's width. A PDF is a link | PDFs are not shown |
| Tag, nested `#a/b` | Tag pane; a parent tag counts its children | A tag is a page; `a/b` is a namespace | The tag's page lists tagged notes, parents too | None |
| Frontmatter `tags` | The list form only. A comma string makes no tags in 1.15.1 | Tags in a block | The list form, or one tag as a string | None |
| Properties | Typed widgets; links are clickable | Attributes `Name:: value`; the attribute's page lists every use | `key:: value` blocks as Roam would hold them: no quotes, tags as tags, a date as a link to that day, a list on one line as its values | No list of notes per property |
| Links in properties | Count as backlinks | References inside an attribute | Counted as backlinks, drawn as the attribute block | None |
| List item | Indented items | Blocks | Roam blocks, nested, with caret and children | None |
| Numbered list | Numbers | A parent block viewed as numbered | Numbers in place of bullets, as Roam draws them | None |
| Heading, paragraph | Sections that fold | Heading blocks, levels 1 to 3 | A heading owns what follows; a paragraph is a block, wrapped lines joined | None |
| Task | Checkbox; any status letter draws checked | `{{[[TODO]]}}`, `{{[[DONE]]}}` | Any status is a ticked box | None |
| Callout | Coloured box with an icon; can fold | Blockquote | Blockquote | The kind is lost when there is a title; fold is ignored |
| Quote | Blockquote | Blockquote | Blockquote | None |
| Highlight `==x==` | Highlight | `^^x^^` | Roam's highlight | None |
| Comment `%%x%%` | Hidden when reading | None | Hidden | None |
| Table | Table | `{{table}}` | Roam's table | Column alignment is not kept; Roam's tables have none |
| Code | Highlighted | Code block | Plain `pre` | No highlighting |
| Mermaid, math | Drawn, typeset | `{{mermaid}}`, `$$` | Code; raw TeX | Needs Roam's own renderers |
| Footnote | Superscript and a notes section | None | Raw `[^1]` | Minor |
| Backlinks pane | One raw line per match. No parent path | Linked References | Roam's layout: path above the block, children under it | Roam's filter and search |
| Unlinked mentions | The name and aliases in plain text, with a Link button | Unlinked References | Not present; only notes with a similar name | Needs note text |
| Opening a note | Tab; ctrl-click a new tab | Main window; shift-click the sidebar | Roam's main window, drawn as a page, with Back and Forward; shift-click a dialog over the page | Roam's sidebar takes no windows from an extension, so shift-click can't open one there |
| Unresolved link | Dimmed; a click creates the note | A link is always a page | Greyed after a click | Minor |
| Rename | Links are rewritten | Renames propagate | The vault is watched and indexed again | None |
| Canvas | A board; its links count as backlinks | None | Not read | Links in a canvas could count as references |

### How Obsidian resolves a link

Measured, because the extension has to give the same answer:

- Matching ignores letter case. A bare name resolves from any folder.
- An alias never resolves a link. `[[Country Loaf]]` stays unresolved when Country Loaf is only an
  alias of `Sourdough Loaf.md`.
- A link with a heading or block that doesn't exist still resolves to the file, and still counts as
  a backlink.
- With two notes of the same name, the one in the linker's folder wins.
- A file that isn't Markdown needs its extension: `[[loaf.png]]` resolves, `[[loaf]]` doesn't.
- `./Note` and `../Folder/Note` resolve from the linker's folder. Markdown links are URL-decoded.
- New links are written as `[[Note]]`, `[[../Folder/Note]]`, `[[Folder/Note]]` or the Markdown-link
  forms of those, depending on two settings (`useMarkdownLinks`, `newLinkFormat`).

## OKF

OKF keeps a note's name and its relations in frontmatter fields and in two reserved files, where
Obsidian keeps them in the file name and in wikilinks.

| OKF | What the spec says | Roam equivalent | Today | Gap |
| --- | --- | --- | --- | --- |
| `title` | The note's name | Page title | Matched like an alias | Show it as the note's name |
| `index.md` | Describes its folder | The page for that folder | The note for the page named like its folder | None |
| `log.md` | Dated entries under `## YYYY-MM-DD` | Blocks on daily pages | Each day is a reference on that day's daily page, entries under it | None |
| Path fields (`superseded_by`, `sources[].resource`) | Relations between notes | References in attributes | A path to a note in any property is a link to it, drawn as the attribute block | None |
| `type`, `status` | Controlled words | Page references in an attribute | Raw text | Draw as page references, so a type's page lists its notes |
| Markdown links | Resolved from the file's folder, then the bundle root; case-sensitive | Page reference | Root first; reference-style links are not read | Follow the spec's order; read reference-style links |
| `tags` | A list | Tags | The list form, or one tag as a string | None |
| Body text | Hard-wrapped paragraphs, GFM tables, footnotes | Blocks | Wrapped lines joined; tables are Roam's table | Footnotes are raw |
| Bundle | A folder of OKF files | A vault | Any folder is a vault | Detect a bundle and switch to OKF's rules |
| Anchor `file.md#section` | A link to a section | Reference to the heading block | A click opens the note with the heading marked | None |

## Roam's side

What the extension copies from Roam, measured in Linked References:

- A reference is the block, with the blocks above it as a grey path. A click on a part of the path
  opens that block in place: the nearest parent shows all its children, a higher one only the child
  on the path.
- A block's children are folded behind a caret that shows on hover.
- A click on a link opens the page. Shift-click opens it in the sidebar, ctrl-shift-click opens its
  linked references there, alt-shift-click its graph.
- A click on a bullet opens the block. A click on text edits it, which Vaults has no equivalent
  for, so there it only follows a link under the pointer.
- The section folds from its caret. The header text does nothing.
- `[[` `]]` are left out of the page entirely when the user hides them.
- A page embed starts closed, as its title on a grey band; the bar at its left opens and closes it.
  A block embed shows the block and its children at once.
- An image is 500 wide until it is resized.
- A table's cells are 150 wide and its first row is like the others. The children of a block viewed
  as numbered have their number where the bullet would be.
- A Markdown export writes one `- ` bullet per block, four spaces a level, the page title as the
  file name, `/` in a title as a folder, and Roam's own inline syntax unchanged (`{{[[TODO]]}}`,
  `^^highlight^^`, `__italics__`, `Name::`).

## What is left, in rough order

1. OKF: detect a bundle, show `title` as the note's name, link order per the spec, `type` and `status` as page references.
2. A page per property key, listing the notes that have it.
3. Linked References' search and filter on the vault section, and its right-click menus.
4. Unlinked mentions from vaults. This needs note text, so it belongs with full-text search.

## What cannot be mapped

- **Graph view, tag pane, quick switcher and the `[[` suggester.** An extension can't add outside
  items to Roam's, and a vault note is not an entity in Roam's graph unless it is written into it.
- **Anything that writes to the vault.** Creating a note from an unresolved link, ticking a task,
  templates, and Obsidian's habit of writing a `^id` into the target when you link to a block.
  Vaults only reads.
- **Bases and the canvas board.** Roam has no view to borrow. Only the links in a canvas map.
- **Bookmarks.** Roam's Shortcuts take pages.
- **Hover previews.** Roam has none for pages.
- **OKF trust tiers, attestation and owners.** They can be shown as attributes and nothing more.
