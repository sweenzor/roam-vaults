# Submitting External Vault References to Roam Depot

Researched 2026-11-09 from the [roam-depot repo](https://github.com/Roam-Research/roam-depot) (README,
workflows and build scripts) and Roam's
[Roam Depot/Extensions developer docs](https://roamdocs.fyi/developer-documentation/roam-depot-extensions).

## How submission works

1. The extension lives in its own public GitHub repo (this one).
2. You fork `Roam-Research/roam-depot` and add one file, `extensions/sweenzor/roam-vaults.json`. The
   path must be `extensions/<github user>/<repo name>.json`. The draft is in
   [`depot/roam-vaults.json`](depot/roam-vaults.json).
3. You open a pull request against `Roam-Research/roam-depot` `main`.
4. A GitHub Action clones this repo at `source_commit`, runs `build.sh`, and uploads a preview build. A bot
   comments with a **PR-shorthand** such as `sweenzor+roam-vaults+1530`. Anyone can load that shorthand in
   **Settings → Roam Depot → Developer Extensions** to test the exact build reviewers will see.
5. The Roam team reviews the code for security. Every update is reviewed, not only the first release.
   For example, [Roam Drop](https://github.com/Roam-Research/roam-depot/pull/1511) took 11 days, and the
   only change the reviewer asked for was a more descriptive README.
6. When the PR is merged, the extension appears in the Roam Depot marketplace.

**Updates** use the same flow: bump `source_commit` in the JSON (in your fork) and open a new PR. Changes
that only touch `.md` or image files are published without resetting the "code updated" date.

## Metadata fields

| Field | Required | Our value |
|---|---|---|
| `name` | yes | External Vault References |
| `short_description` | yes | One line, shown in the marketplace list |
| `author` | yes | Shown to users. Draft says `sweenzor`; use your display name if you prefer |
| `tags` | no | obsidian, markdown, vault, references, backlinks |
| `source_url` | yes | https://github.com/sweenzor/roam-vaults |
| `source_repo` | yes | https://github.com/sweenzor/roam-vaults.git |
| `source_commit` | yes | The exact commit that is reviewed and published |
| `source_subdir` | no | `extension` (see below) |
| `stripe_account` | no | Only if you want revenue-share payouts from Roam |

`source_subdir` isn't in the README, but the Depot build script supports it: it runs `build.sh` inside that
folder, then copies `extension.js`, `extension.css`, `README.md` and `CHANGELOG.md` from it to the root.
That lets the extension stay in `extension/` next to the spike and docs.

## Files the Depot reads

| File | Status |
|---|---|
| `extension/README.md` (required) | Rewritten for users. Roam shows it as the extension's page in the marketplace |
| `extension/extension.js` (required) | Written by `extension/build.sh` from `dist/extension.js` |
| `extension/CHANGELOG.md` (optional) | Added, 0.1.0 entry |
| `extension/extension.css` (optional) | Not used. Styles are injected by `extension.js` and removed on unload |
| `extension/build.sh` | Added. Runs `npm ci` and `npm run build` on Ubuntu 24.04; npm is available there. The job has a 5-minute limit, and the build takes seconds |

Images in the README must be absolute URLs because Roam renders it outside GitHub. The README points at
`raw.githubusercontent.com/sweenzor/roam-vaults/v0.1.0/docs/images/…`, so those images appear once the
`v0.1.0` tag exists.

## Review rules, and how we meet them

| Rule (from Roam's developer docs) | Status |
|---|---|
| Default export with `onload` and `onunload`; everything set up in `onload` is removed in `onunload` | Meets. Commands, observers, listeners, styles, workers, the Blob URL, the viewer and all injected nodes are removed |
| Dependencies are "scrutinized heavily"; use none if you can | Meets. No runtime dependencies. Only esbuild and TypeScript at build time |
| Use Roam's shared libraries (React, Blueprint, `idb`, …) instead of bundling your own copy | Meets. Nothing bundled. IndexedDB is used directly, not through a bundled `idb` |
| Prefix CSS classes to avoid clashes | Meets. All classes start with `rv-` |
| Prefer Blueprint components and Roam's look | Meets. Uses Roam's own `bp3-` and `rm-` classes so it matches Linked References |
| Handle running offline | Meets. It never uses the network |
| No `eval` or code fetched at run time. Extensions that use `eval` get a warning badge and can't be installed for other graph members | Meets. No `eval`, `new Function`, dynamic `import()` or `fetch` |
| Allowed languages: TypeScript, JavaScript or ClojureScript | Meets. TypeScript |

**One thing to explain in the PR:** the indexer runs in Web Workers started from a Blob URL. The worker code
is bundled into `extension.js` at build time (`build.mjs` inlines it as a string), so nothing outside the
reviewed file runs. Reviewers scan for code loading, so the PR description should say this up front.

**No Depot rule covers local file access.** Nothing in the docs forbids the File System Access API. The
extension asks for read-only access, only to folders the user picks.

**Uploads.** No rule covers `roamAlphaAPI.file.upload` either. Version 0.1.0 doesn't upload anything. If the
opt-in mobile snapshot ships later, its README section already warns that the snapshot link can be
downloaded by anyone who has it.

## Before you submit (checklist)

- [ ] Merge Phase 1 (PR #2) and this docs PR.
- [ ] Create a `main` branch and make it the default branch. The repo currently has no `main`, and the
      marketplace links to `source_url`.
- [ ] Decide the license. This PR adds MIT; swap it if you want something else.
- [ ] Decide what `author` should say.
- [ ] Test the Depot build: in a fresh clone run `cd extension && ./build.sh`, then load the `extension`
      folder in developer mode on a hosted graph.
- [ ] Change "0.1.0 (unreleased)" in `extension/CHANGELOG.md` to the release date. `package.json` is
      already `0.1.0`.
- [ ] Tag the release commit `v0.1.0` and push the tag. The README images load from that tag.
- [ ] Put the release commit's full SHA in `docs/depot/roam-vaults.json` as `source_commit`.
- [ ] Fork `Roam-Research/roam-depot`, copy the JSON to `extensions/sweenzor/roam-vaults.json`, and open
      the PR with the description below.
- [ ] When the bot posts the PR-shorthand, load it in Roam and check it once more.

## Draft PR description for roam-depot

> **Add External Vault References**
>
> Shows notes from a local Markdown folder (such as an Obsidian vault) that match or link to the current
> Roam page, in a section below Linked References. Several vaults are supported, one section each.
>
> - Read-only. Uses the File System Access API (`showDirectoryPicker`, read mode) on folders the user
>   picks. Folder handles stay in local IndexedDB, never in the graph.
> - No network requests, no `eval`, no `new Function`, no dynamic `import()`.
> - The indexer runs in Web Workers started from a Blob URL. The worker code is bundled into
>   `extension.js` at build time by `build.mjs`. Nothing is fetched.
> - No runtime dependencies. `build.sh` (in `extension/`, via `source_subdir`) runs `npm ci` and esbuild.
> - Everything added in `onload` is removed in `onunload`.
>
> Source: https://github.com/sweenzor/roam-vaults (MIT)
