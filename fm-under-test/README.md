# File Manager for Roam Research

See, sort and clean up the files uploaded to your Roam graph.

File Manager adds **All Files** to the left sidebar, under All Pages. It lists every file you've
uploaded to the graph (images, PDFs, audio, video and anything else) in a table that works like
All Pages.

- **Sort** by name, type, size, number of uses or date added. Newest files come first.
- **Search** by file name, type or the page a file is on.
- **Filter** by kind of file, or to files no block uses any more.
- Click a file's name to open it, or its page to go to the block that holds it. Shift-click opens the
  block in the right sidebar.
- **Delete** files that no block uses, to free up their storage. Roam asks before anything is deleted,
  and a file that a block still uses can't be deleted.

## Unused files

When you delete a block that holds an upload, Roam keeps the file in storage. File Manager notes the
files it sees in your blocks, so when one of them is no longer in any block it shows up under the
Unused filter, where you can delete it.

Roam doesn't let an extension list a graph's stored files, so File Manager can only find unused files
that it has seen in a block at some point since it was installed. This list is kept on your device.

## Notes

- File sizes and upload dates come from Roam's file storage. They're fetched the first time the list is
  opened and kept on your device after that.
- Only files uploaded to the graph you're in can be deleted. A file pasted in from another graph is
  listed but belongs to that graph.
- Deleting a file is permanent.

## Development

```
npm install
npm test             # unit tests
npm run build        # writes extension.js
node test/help-graph.mjs   # the build in Roam's public help graph, headless (needs Playwright)
```

To load a build in Roam: Settings > Roam Depot > enable developer mode, then load this folder.
`test/real-roam/run.mjs` runs the build in Roam's desktop app against a hosted test graph; see
`.github/workflows/real-roam.yml`.
