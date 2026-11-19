// Vaults: shows notes from Obsidian-style vaults (local Markdown folders) that match or
// link to the Roam page you are on. Read-only; nothing is written to the graph; no network.
import { loadVaults, saveVaults } from './store.ts';
import { deleteNotes } from '../cache-db.ts';
import { pickVaultFolder, ensurePermission } from './picker.ts';
import { setScanMark, closeScanMark, unfinishedScans } from './scan-mark.ts';
import { createSettingsPanel, COUNTS_SETTING, type SettingsVault } from './settings.ts';
import { ATTR, installStyles, renderPanel, renderCounts, h, type Count, notify, removeToast, openViewer, closeViewer, type SectionState, type SectionActions, type PanelVault, type ViewerActions } from './ui.ts';
import type { PageResult } from '../engine.ts';
import { OPEN_WITH_SETTING, openLink, openLabel } from './open-with.ts';

declare const WORKER_SOURCE: string; // injected by build.mjs
declare global { interface Window { roamAlphaAPI: any } }

// ---------- one connected vault: its own indexer worker ----------
let workerUrl = '';
const MAX_RESULTS = 50; // page results kept per vault; the least recently used goes first
class Vault implements PanelVault {
  id: string; handle: FileSystemDirectoryHandle; name: string;
  state: SectionState = { kind: 'indexing', detail: '' };
  results = new Map<string, PageResult | null>();
  act: SectionActions;
  private worker: Worker;
  private seq = 0;
  private waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private gen = 0;        // goes up whenever cached results go stale
  private opened = false; // has the worker been given the folder?
  private stopped = false;
  private token: string | null = null; // this vault's scan mark, while set (see scan-mark.ts)

  constructor(id: string, handle: FileSystemDirectoryHandle) {
    this.id = id; this.handle = handle; this.name = handle.name;
    this.worker = new Worker(workerUrl);
    this.worker.onmessage = ({ data }) => {
      if (data.id !== undefined) {
        const w = this.waiting.get(data.id); this.waiting.delete(data.id);
        if (data.ok) w?.res(data.result); else w?.rej(new Error(data.error));
      } else if (data.type === 'status') this.onStatus(data.state, data.detail, data.live, data.notLiveWhy, data.scanning);
      else if (data.type === 'changed') { this.stale(); refreshAll(); }
    };
    this.worker.onerror = (e) => {
      const detail = e.message || 'indexer crashed';
      this.fail(new Error(detail));
      this.set({ kind: 'error', detail });
    };
    const viewer: ViewerActions = {
      read: (path) => this.call<string>('read', { path }),
      resolve: (target, from) => this.call<string | null>('resolve', { target, from }).catch(() => null),
      openOutside: (path) => this.openOutside(path),
      openLabel: () => openLabel(openWith()),
    };
    this.act = {
      ...viewer,
      reconnect: () => this.connect(true),
      remove: () => removeVault(this),
      view: (path, line) => openViewer(path, line, viewer),
    };
  }
  call<T>(cmd: string, args?: unknown): Promise<T> {
    const id = ++this.seq;
    return new Promise((res, rej) => { this.waiting.set(id, { res, rej }); this.worker.postMessage({ id, cmd, args }); });
  }
  notes = '';
  /** Progress of a scan that runs while the vault can already answer (state "ready"), or ''. */
  scanning = '';
  private stale() { this.gen++; this.results.clear(); }
  /** Settle every call still waiting on the worker, so nothing waits for an answer that can't come. */
  private fail(e: Error) {
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    waiting.forEach((w) => w.rej(e));
  }
  set(s: SectionState, scanning = '') {
    if (this.stopped) return;
    // Progress of a scan only shows in settings: pages have nothing to redraw for it. That goes
    // for a vault that stays ready too: what changes in its index comes as a "changed" message.
    const progress = s.kind === this.state.kind && (s.kind === 'indexing' || s.kind === 'ready');
    this.state = s;
    this.scanning = scanning;
    this.mark(s.kind === 'indexing' || s.kind === 'unfinished' || !!scanning);
    if (!progress) { this.stale(); refreshAll(); }
    changed();
  }
  private onStatus(s: string, detail: string, live: boolean, notLiveWhy: string, scanning = '') {
    if (s === 'indexing') this.set({ kind: 'indexing', detail });
    else if (s === 'error') this.set({ kind: 'error', detail });
    else if (s === 'ready') {
      this.notes = detail;
      if (!live && !scanning) console.warn('[roam-vaults]', this.name, 'no live updates:', notLiveWhy);
      this.set({ kind: 'ready', result: null, live }, scanning);
    }
  }
  /** Set or clear the scan mark (see scan-mark.ts). */
  mark(on: boolean) {
    if (on === (this.token !== null)) return;
    this.token = on ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` : null;
    void setScanMark(this.id, this.token);
  }
  /** Roam is closing or reloading mid-scan, which isn't a crash: the scan starts again next time. */
  closing() {
    if ((this.state.kind !== 'indexing' && !this.scanning) || this.token === null) return;
    closeScanMark(this.id, this.token);
    this.token = null;
  }
  async connect(ask: boolean) {
    let allowed = false;
    try { allowed = await ensurePermission(this.handle, ask); }
    catch (e) { console.warn('[roam-vaults] permission check failed for', this.name, e); }
    if (!allowed) { this.set({ kind: 'permission' }); return; }
    this.set({ kind: 'indexing', detail: '' });
    this.opened = true;
    try {
      const stats: any = await this.call('open', { handle: this.handle, key: this.id });
      if (stats.errors?.length) console.warn('[roam-vaults] unreadable files in', this.name, stats.errors);
    } catch (e) {
      this.set({ kind: 'error', detail: (e as Error).message });
    }
  }
  async query(title: string): Promise<PageResult | null> {
    if (this.state.kind !== 'ready') return null;
    let r = this.results.get(title);
    if (r !== undefined) { this.results.delete(title); this.results.set(title, r); } // most recently used last
    else {
      const gen = this.gen;
      r = await this.call<PageResult | null>('query', { title }).catch(() => null);
      if (gen === this.gen) { // an answer from before a change is not kept
        this.results.set(title, r);
        if (this.results.size > MAX_RESULTS) this.results.delete(this.results.keys().next().value!);
      }
    }
    return r;
  }
  /** Scan the folder again. A vault that still needs permission has nothing to scan. */
  async rescan() {
    if (!this.opened || this.stopped) return;
    await this.call('rescan').catch(() => {}); // the worker reports a failed scan as an error status
  }
  /** Open the note in Obsidian, or in the editor the "Open notes with" setting names. */
  openOutside(path: string) {
    const a = document.createElement('a');
    a.href = openLink(openWith(), this.name, path);
    a.rel = 'noopener';
    a.click();
  }
  stop() { this.mark(false); this.stopped = true; this.worker.terminate(); this.fail(new Error('The vault was removed.')); }
}

let vaults: Vault[] = [];
let settingsAPI: { get?(id: string): unknown } | undefined;
const openWith = () => { try { return settingsAPI?.get?.(OPEN_WITH_SETTING); } catch { return undefined; } };
// Vault management lives in the extension's settings page; it re-renders on every change.
const listeners = new Set<() => void>();
function changed() { listeners.forEach((fn) => fn()); }
function settingsVault(v: Vault): SettingsVault {
  const s = v.state;
  const status = s.kind === 'permission' ? 'Needs permission again'
    : s.kind === 'unfinished' ? "Last scan didn't finish"
    : s.kind === 'indexing' ? `Indexing${s.detail ? ` ${s.detail}` : '…'}`
    : s.kind === 'error' ? `Couldn't read: ${s.detail}`
    : v.scanning ? `Indexing ${v.scanning}` // its files are being checked, and pages show what it has
    : `${v.notes || 'Ready'}${s.live ? '' : ' · not live'}`;
  return { id: v.id, name: v.name, status, needsPermission: s.kind === 'permission', unfinished: s.kind === 'unfinished', reconnect: () => v.connect(true), remove: () => removeVault(v) };
}
const save = () => { changed(); return saveVaults(vaults.map((v) => ({ id: v.id, handle: v.handle }))).catch((e) => console.warn('[roam-vaults]', e)); };

async function addVault() {
  const load = loads;
  const h = await pickVaultFolder();
  if (!h || load !== loads) return; // nothing picked, or unloaded while the picker was open
  for (const v of vaults) if (await v.handle.isSameEntry(h)) { notify(`"${h.name}" is already added.`); return; }
  let id = h.name, n = 2;
  while (vaults.some((v) => v.id === id)) id = `${h.name} (${n++})`;
  const v = new Vault(id, h);
  vaults.push(v);
  inject(); // pages get no panel while there are no vaults
  await save();
  await v.connect(false);
}
const dropCache = (v: Vault) => deleteNotes(v.id).catch((e) => console.warn('[roam-vaults] cache not cleared', e));
async function removeVault(v: Vault) {
  v.stop(); // terminates the worker first, so no pending cache save can recreate the entry
  await dropCache(v);
  vaults = vaults.filter((x) => x !== v);
  await save();
  refreshAll();
}

// ---------- which Roam page is each panel for? ----------
async function openPageTitle(): Promise<string | null> {
  const api = window.roamAlphaAPI;
  const uid = await api?.ui?.mainWindow?.getOpenPageOrBlockUid?.();
  if (!uid) return null;
  const r = api.pull('[:node/title {:block/page [:node/title]}]', [':block/uid', uid]);
  return r?.[':node/title'] ?? r?.[':block/page']?.[':node/title'] ?? null;
}
/** Title for a Linked References section: its own page in the daily-notes log, else the open page
 *  (for a zoomed-in block, the page that block is on). The spike read .rm-title-display, which a
 *  zoomed block doesn't have, and showed "(no title)". */
async function titleFor(refs: HTMLElement): Promise<string | null> {
  const logPage = refs.closest('.roam-log-page');
  if (logPage) return logPage.querySelector('.rm-title-display')?.textContent?.trim() || null;
  return openPageTitle();
}

// ---------- panel injection ----------
const fills = new WeakMap<HTMLElement, number>();
async function fill(panel: HTMLElement) {
  const title = panel.dataset.title!;
  const seq = (fills.get(panel) ?? 0) + 1;
  fills.set(panel, seq);
  const snapshot = vaults.slice();
  const states = await Promise.all(snapshot.map(async (v): Promise<PanelVault> =>
    v.state.kind === 'ready' ? { id: v.id, name: v.name, act: v.act, state: { ...v.state, result: await v.query(title) } } : v));
  // A fill started later carries newer results, so this one must not draw over it.
  if (fills.get(panel) !== seq || panel.dataset.title !== title || !panel.isConnected) return;
  panel.dataset.count = String(renderPanel(panel, states));
  const refs = panel.previousElementSibling;
  if (refs instanceof HTMLElement && refs.matches('.rm-reference-main')) syncCounts(refs, panel);
}
function refreshAll() {
  document.querySelectorAll<HTMLElement>(`.rv-panel[${ATTR}]`).forEach(fill);
}

// ---------- counts under the page title ----------
/** The page title a references area belongs to: its own day in the daily-notes log, else the
 *  page's. A zoomed-in block has no title, so it gets no counts. */
function titleBox(scope: Element | null): HTMLElement | null {
  const h1 = scope?.querySelector<HTMLElement>('.rm-title-display');
  return h1 ? h1.closest<HTMLElement>('.rm-title-display-container') ?? h1 : null;
}
const scopeOf = (el: Element) => el.closest('.roam-log-page') ?? el.closest('.roam-article');
/** Roam's own section header ("15 Linked References"), read from the page as Roam drew it. */
function roamHeader(refs: Element, kind: 'Linked' | 'Unlinked'): HTMLElement | null {
  const sel = kind === 'Linked' ? '.rm-reference-container > .flex-h-box strong' : '.rm-unlinked-reference-container > .flex-h-box strong';
  return refs.querySelector<HTMLElement>(sel);
}
const countIn = (el: HTMLElement | null) => { const m = el?.textContent?.match(/^\s*(\d+)\s/); return m ? +m[1] : 0; };

// Roam counts unlinked references only once that section is opened. Until then the count comes
// from the same search Roam runs: blocks whose text has the title in any case, that don't link to
// the page. Worked out once per page visit; an open section's own number wins.
const unlinked = new Map<string, number | null>(); // null: being worked out, or no answer
const UNLINKED_KEPT = 50;
async function countUnlinked(title: string) {
  if (unlinked.has(title)) return;
  unlinked.set(title, null);
  if (unlinked.size > UNLINKED_KEPT) unlinked.delete(unlinked.keys().next().value!);
  const api = window.roamAlphaAPI;
  const q = api?.data?.async?.q ?? api?.q;
  if (!q) return;
  const pattern = '(?i)' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    const n = await q.call(api?.data?.async?.q ? api.data.async : api,
      '[:find (count ?b) . :in $ ?pat ?t :where [?p :node/title ?t] [(re-pattern ?pat) ?re] [?b :block/string ?s] [(re-find ?re ?s)] (not [?b :block/refs ?p])]',
      pattern, title);
    if (!unlinked.has(title)) return; // dropped meanwhile: a newer count is on its way
    unlinked.set(title, typeof n === 'number' ? n : 0);
    syncAllCounts();
  } catch (e) { console.warn('[roam-vaults] unlinked count failed', e); }
}

/** The counts line is off unless the "Reference counts" setting is on. */
let showCounts = false;
function setShowCounts(on: boolean) {
  if (on === showCounts) return;
  showCounts = on;
  if (!on) document.querySelectorAll(`.rv-counts[${ATTR}]`).forEach((n) => n.remove());
  syncAllCounts();
}

function jumpTo(el: Element | null | undefined) { el?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
function syncCounts(refs: HTMLElement, panel: HTMLElement) {
  if (!showCounts) return;
  const box = titleBox(scopeOf(refs));
  if (!box) return;
  let line = box.nextElementSibling as HTMLElement | null;
  if (!line?.matches(`.rv-counts[${ATTR}]`)) {
    line = h('div', { class: 'rv-counts', [ATTR]: 'counts' });
    box.after(line);
  }
  const title = panel.dataset.title ?? '';
  if (!unlinked.has(title)) countUnlinked(title);
  // The jumps look the sections up when clicked: Roam may have drawn them again since.
  const here = () => { const s = scopeOf(line!); return s?.querySelector<HTMLElement>('.rm-reference-main') ?? null; };
  const counts: Count[] = [];
  const linked = roamHeader(refs, 'Linked');
  if (countIn(linked)) counts.push({ label: linked!.textContent!.trim(), jump: () => jumpTo(roamHeader(here() ?? refs, 'Linked')?.closest('.flex-h-box')) });
  const own = roamHeader(refs, 'Unlinked');
  const u = countIn(own) || (unlinked.get(title) ?? 0);
  if (u) counts.push({ label: `${u} Unlinked References`, jump: () => jumpTo(roamHeader(here() ?? refs, 'Unlinked')?.closest('.flex-h-box')) });
  const ext = Number(panel.dataset.count ?? 0);
  if (ext) counts.push({ label: `${ext} External Vault References`, jump: () => jumpTo(here()?.parentElement?.querySelector(`:scope > .rv-panel[${ATTR}]`) ?? panel) });
  renderCounts(line, counts);
}
function syncAllCounts() {
  document.querySelectorAll<HTMLElement>(`.rv-panel[${ATTR}]`).forEach((panel) => {
    const refs = panel.previousElementSibling;
    if (refs instanceof HTMLElement && refs.matches('.rm-reference-main')) syncCounts(refs, panel);
  });
}

let scanning = false, scanAgain = false;
async function inject() {
  if (!vaults.length) return; // nothing to show, so no work on page changes
  if (scanning) { scanAgain = true; return; } // the page changed mid-scan: look again afterwards
  scanning = true;
  try {
    const refsEls = document.querySelectorAll<HTMLElement>('.roam-article .rm-reference-main');
    for (const refs of refsEls) {
      const parent = refs.parentElement;
      if (!parent) continue;
      const title = await titleFor(refs);
      if (!title) continue;
      let panel = parent.querySelector<HTMLElement>(`:scope > .rv-panel[${ATTR}]`);
      if (panel && panel.dataset.title === title) { syncCounts(refs, panel); continue; }
      unlinked.delete(title); // a page visit: its unlinked count is worked out afresh
      if (!panel) {
        panel = document.createElement('div');
        panel.setAttribute(ATTR, 'panel');
        panel.className = 'rv-panel';
        parent.insertBefore(panel, refs.nextSibling); // below Roam's own references
      }
      panel.dataset.title = title;
      panel.dataset.count = '0';
      syncCounts(refs, panel);
      fill(panel);
    }
  } finally { scanning = false; }
  if (scanAgain) { scanAgain = false; inject(); }
}

// ---------- lifecycle ----------
const cleanups: (() => void)[] = [];
let loads = 0; // goes up on every load and unload, so a load still in progress can tell it was unloaded

async function onload({ extensionAPI }: { extensionAPI: any }) {
  const load = ++loads;
  cleanups.push(installStyles());
  settingsAPI = extensionAPI?.settings;
  try { showCounts = settingsAPI?.get?.(COUNTS_SETTING) === true; } catch { showCounts = false; }
  workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));

  // No command palette entries (so no hotkeys either): vaults are managed in the settings panel.
  createSettingsPanel(extensionAPI, {
    vaults: () => vaults.map(settingsVault),
    add: addVault,
    rescan: () => vaults.forEach((v) => v.rescan()),
    countsChanged: setShowCounts,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  });
  cleanups.push(() => listeners.clear());

  let frame = 0;
  const mo = new MutationObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(inject); });
  mo.observe(document.body, { childList: true, subtree: true });
  cleanups.push(() => { mo.disconnect(); cancelAnimationFrame(frame); });
  // Closing or reloading Roam mid-scan isn't a crash: the scan starts again next time as usual.
  const onHide = () => vaults.forEach((v) => v.closing());
  window.addEventListener('pagehide', onHide);
  cleanups.push(() => window.removeEventListener('pagehide', onHide));
  const onHash = () => requestAnimationFrame(inject);
  window.addEventListener('hashchange', onHash);
  cleanups.push(() => window.removeEventListener('hashchange', onHash));

  const saved = await loadVaults().catch(() => []);
  if (load !== loads) return; // unloaded while the saved vaults were being read
  const unfinished = await unfinishedScans(saved.map((x) => x.id));
  if (load !== loads) return;
  vaults = saved.map((x) => new Vault(x.id, x.handle));
  for (const v of vaults) if (unfinished.has(v.id)) v.set({ kind: 'unfinished' });
  changed();
  inject();
  await Promise.all(vaults.map((v) => v.state.kind === 'unfinished' ? null : v.connect(false)));
}

function onunload() {
  loads++;
  showCounts = false;
  cleanups.splice(0).forEach((f) => f());
  vaults.forEach((v) => v.stop()); vaults = [];
  URL.revokeObjectURL(workerUrl);
  closeViewer();
  removeToast();
  document.querySelectorAll(`[${ATTR}]`).forEach((n) => n.remove());
}

export default { onload, onunload };
