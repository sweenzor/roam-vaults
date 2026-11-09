# In-app spike (FEASIBILITY.md §9)

This is a throwaway Roam extension that checks the six assumptions only the real Roam desktop app can
confirm. It writes nothing to your graph and makes no network requests. Results show in a floating
panel at the bottom right. They are also saved in `localStorage`, so they survive restarts. Use
**Copy log** to get them out.

## Load it

1. Put this folder (`extension.js` plus this README) somewhere on your computer.
2. In Roam desktop, open **Settings → Roam Depot → Developer mode**, then **Load extension from folder**,
   and choose this folder.
3. The panel appears. The first line is `env INFO …` with the Chromium/Electron version, then
   `1 persist NO HANDLE`. That is expected on the first run.

## Run the checks, in order

| # | Do this | Pass looks like |
|---|---|---|
| 1a | Click **1 Pick vault** and choose a real vault folder (not `~/Documents` itself) | `1 pick OK … permission now=granted`, with no "Let this site view files?" dialog |
| 3 | Click **1 Pick vault** again and choose `~/Documents` itself, then cancel or accept whatever appears | Note exactly what happened: an error line or a system dialog. Then **pick your real vault again** so the next steps use it. |
| 2 | Click **2 Watch**. In Obsidian, edit a note, create one and rename one | `2 observer EVENT modified/appeared/moved …` lines |
| 4 | Navigate around: a few pages, the daily-notes log, zoom into a block, open a page in the right sidebar | A dashed purple "Vault references (spike)" box above Linked References on each main page, with only one box per page |
| 5+6 | Click **5+6 Scan** (use your largest vault) | `5 worker PASS`, then `6 scan DONE N .md files … walk X ms, read Y ms` |
| 1b | **Quit Roam completely** (Cmd/Ctrl+Q, not just close the window) and relaunch it | The extension may need to be re-enabled (see below). Then the panel shows `1 persist PASS (onload) … queryPermission=granted` |
| 1c | Only if 1b shows `NOT GRANTED`: click **1 Request** | `granted` with a time close to 0 ms means no dialog was shown |

**Developer-mode caveat:** extensions loaded from a local folder may not auto-start after a restart.
If the panel is missing after relaunching, turn the extension back on in Roam Depot. Check 1b only
reads the *saved* handle, so re-enabling doesn't affect the result.

When you're done, click **Copy log** and paste the result back. To remove the extension, use
Roam Depot. The saved handle lives in the `vault-spike` IndexedDB database on roamresearch.com.
