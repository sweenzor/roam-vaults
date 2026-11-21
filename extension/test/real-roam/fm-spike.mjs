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
  put('api', await evalIn(() => {
    const a = window.roamAlphaAPI, keys = (o) => (o ? Object.keys(o) : null);
    return { top: keys(a), file: keys(a.file), ui: keys(a.ui), leftSidebar: keys(a.ui.leftSidebar), mainWindow: keys(a.ui.mainWindow),
      data: keys(a.data), util: keys(a.util), graph: a.graph, platform: keys(a.platform),
      libs: { React: window.React?.version, ReactDOM: !!window.ReactDOM, Blueprint: keys(window.Blueprint)?.slice(0, 5), BPcore: !!window.Blueprint?.Core, idb: !!window.idb, FullCalendar: !!window.FullCalendar } };
  }));
  put('attrs', await evalIn(() => window.roamAlphaAPI.data.q('[:find ?a :where [_ ?a _]]').map((r) => String(r[0])).sort()));
  put('fileBlocks', await evalIn(() => window.roamAlphaAPI.data.q('[:find ?s ?ct :where [?b :block/string ?s] [?b :create/time ?ct] [(clojure.string/includes? ?s "firebasestorage")]]').slice(0, 10)));
  // upload a tiny PNG to the test graph, read its storage metadata, then delete it
  const up = await evalIn(async () => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'fm-probe.png', { type: 'image/png' });
    const r = { };
    try { r.url = await window.roamAlphaAPI.file.upload({ file, toast: { hide: true } }); } catch (e) { r.uploadError = String(e); return r; }
    const u = new URL(typeof r.url === 'string' ? r.url.match(/https:[^)\s]+/)?.[0] ?? r.url : '');
    const meta = u.origin + u.pathname;
    for (const [k, url, opt] of [['meta', meta], ['metaToken', meta + '?token=' + (u.searchParams.get('token') ?? '')],
      ['list', u.origin + u.pathname.replace(/%2F[^%]*$/, '').replace(/\/o\/.*/, '/o') + '?prefix=' + encodeURIComponent(decodeURIComponent(u.pathname.split('/o/')[1]).replace(/[^/]*$/, '')) + '&maxResults=3'],
      ['head', r.url.match?.(/https:[^)\s]+/)?.[0] ?? r.url, { method: 'HEAD' }]]) {
      try { const q = await fetch(url, opt); r[k] = { status: q.status, headers: [...q.headers].filter(([h]) => /length|type|modified|date|etag|goog/i.test(h)), body: k === 'head' ? '' : (await q.text()).slice(0, 1500) }; }
      catch (e) { r[k] = { error: String(e) }; }
    }
    try { r.get = await window.roamAlphaAPI.file.get({ url: r.url }).then((f) => ({ name: f.name, size: f.size, type: f.type, lastModified: f.lastModified })); } catch (e) { r.getError = String(e); }
    try { await window.roamAlphaAPI.file.delete({ url: r.url }); r.deleted = true; } catch (e) { r.deleteError = String(e); }
    return r;
  });
  put('upload', up);
  // left sidebar + All Pages DOM
  put('leftSidebar', await evalIn(() => {
    const sb = document.querySelector('.roam-sidebar-container, .roam-sidebar-content');
    return sb ? sb.outerHTML.replace(/\s+/g, ' ').slice(0, 5000) : null;
  }));
  await shot('daily-notes');
  const clicked = await evalIn(() => { const el = [...document.querySelectorAll('.log-button, .roam-sidebar-content *')].find((e) => e.textContent.trim() === 'All Pages'); el?.click(); return !!el; });
  log('clicked All Pages', clicked, roam.page.url());
  await sleep(3000);
  await shot('all-pages');
  put('allPagesUrl', roam.page.url());
  put('allPages', await evalIn(() => (document.querySelector('.roam-body-main') ?? document.body).outerHTML.replace(/\s+/g, ' ').slice(0, 12000)));
  put('allPagesStyles', await evalIn(() => {
    const pick = (sel) => { const e = document.querySelector(sel); if (!e) return null; const s = getComputedStyle(e); return { cls: e.className, font: s.font, color: s.color, bg: s.backgroundColor, pad: s.padding, border: s.borderBottom }; };
    return { th: pick('.roam-body-main th'), td: pick('.roam-body-main td'), table: pick('.roam-body-main table'), input: pick('.roam-body-main input'), title: pick('.roam-body-main h1, .roam-body-main .rm-title-display') };
  }));
} catch (e) {
  log('ERROR', e.message);
  await shot('error');
} finally {
  fs.writeFileSync(path.join(OUT, 'found.json'), JSON.stringify(found, null, 2));
  process.exit(0);
}
