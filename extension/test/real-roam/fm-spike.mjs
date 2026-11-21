// Throwaway probe for the File Manager extension (sweenzor/roam-file-manager): signs in to the test
// graph and prints what Roam offers for attachments. Not part of Vaults; lives on a branch only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { roam, log, sleep, evalIn, launchRoam, signIn, openGraph, waitFor, shot, dismissDialogs } from './roam.mjs';

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;
const GRAPH = process.env.ROAM_GRAPH || 'vault-spike-hosted';
const OUT = path.resolve(process.env.OUT || 'real-roam-out');
fs.mkdirSync(OUT, { recursive: true });
roam.out = OUT; roam.logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-'));
const found = {};
const put = (k, v) => { found[k] = v; log('FOUND', k, JSON.stringify(v).slice(0, 4000)); };

try {
  await launchRoam();
  await signIn(EMAIL, PASSWORD);
  await openGraph(GRAPH);
  await sleep(3000);
  put('probe2', await evalIn(async () => {
    const a = window.roamAlphaAPI, r = {};
    const src = (f) => (typeof f === 'function' ? f.toString().slice(0, 900) : String(f));
    r.mw = Object.fromEntries(Object.entries(a.ui.mainWindow).map(([k, v]) => [k, src(v)]));
    r.components = a.ui.components ? Object.fromEntries(Object.entries(a.ui.components).map(([k, v]) => [k, src(v)])) : null;
    r.react = a.ui.react ? Object.fromEntries(Object.entries(a.ui.react).map(([k, v]) => [k, src(v)])) : null;
    r.openView = (() => { try { return a.ui.mainWindow.getOpenView(); } catch (e) { return String(e); } })();
    r.firebase = typeof window.firebase === 'object' ? Object.keys(window.firebase).slice(0, 30) : typeof window.firebase;
    const leftover = 'https://firebasestorage.googleapis.com/v0/b/firescript-577a2.appspot.com/o/imgs%2Fapp%2Fvault-spike-hosted%2FHTvnh2nyAY.png?alt=media&token=6f01695f-13d6-4bb9-bc11-4377b5ccd81b';
    try { r.get = await a.file.get({ url: leftover }).then((f) => ({ name: f.name, size: f.size, type: f.type, lastModified: f.lastModified })); } catch (e) { r.getError = String(e); }
    try { await a.file.delete({ url: leftover }); r.deleted = true; } catch (e) { r.deleteError = String(e); }
    r.afterDelete = await fetch(leftover.replace(/\?.*/, '')).then((q) => q.status, (e) => String(e));
    if (window.firebase?.storage) {
      try { const l = await window.firebase.storage().ref('imgs/app/vault-spike-hosted').listAll(); r.listAll = l.items.length; } catch (e) { r.listAllError = String(e); }
    }
    return r;
  }));
} catch (e) {
  log('ERROR', e.message);
  await shot('error');
} finally {
  fs.writeFileSync(path.join(OUT, 'found.json'), JSON.stringify(found, null, 2));
  process.exit(0);
}
