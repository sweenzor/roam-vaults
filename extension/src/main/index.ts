// Vaults: shows notes from Obsidian-style vaults (local Markdown folders) that match or
// link to the Roam page you are on. Read-only; nothing is written to the graph; no network.
import { loadVaults, saveVaults, deleteCache } from './store.ts';
import { pickVaultFolder, ensurePermission } from './picker.ts';
import { createSettingsPanel, type SettingsVault } from './settings.ts';
import { ATTR, installStyles, renderPanel, notify, removeToast, openViewer, closeViewer, type SectionState, type SectionActions, type PanelVault, type ViewerActions } from './ui.ts';
import type { PageResult } from '../engine.ts';

declare const WORKER_SOURCE: string; // injected by build.mjs
declare global { interface Window { roamAlphaAPI: any } }

// ---------- one connected vault: its own indexer worker ----------
let workerUrl = '';
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

  constructor(id: string, handle: FileSystemDirectoryHandle) {
    this.id = id; this.handle = handle; this.name = handle.name;
    this.worker = new Worker(workerUrl);
    this.worker.onmessage = ({ data }) => {
      if (data.id !== undefined) {
        const w = this.waiting.get(data.id); this.waiting.delete(data.id);
        if (data.ok) w?.res(data.result); else w?.rej(new Error(data.error));
      } else if (data.type === 'status') this.onStatus(data.state, data.detail, data.live, data.notLiveWhy);
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
      openInObsidian: (path) => this.openInObsidian(path),
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
  private stale() { this.gen++; this.results.clear(); }
  /** Settle every call still waiting on the worker, so nothing waits for an answer that can't come. */
  private fail(e: Error) {
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    waiting.forEach((w) => w.rej(e));
  }
  set(s: SectionState) { if (this.stopped) return; this.state = s; this.stale(); refreshAll(); changed(); }
  private onStatus(s: string, detail: string, live: boolean, notLiveWhy: string) {
    if (s === 'indexing') this.set({ kind: 'indexing', detail });
    else if (s === 'error') this.set({ kind: 'error', detail });
    else if (s === 'ready') {
      this.notes = detail;
      if (!live) console.warn('[roam-vaults]', this.name, 'no live updates:', notLiveWhy);
      this.set({ kind: 'ready', result: null, live });
    }
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
    if (r === undefined) {
      const gen = this.gen;
      r = await this.call<PageResult | null>('query', { title }).catch(() => null);
      if (gen === this.gen) this.results.set(title, r); // an answer from before a change is not kept
    }
    return r;
  }
  /** Scan the folder again. A vault that still needs permission has nothing to scan. */
  async rescan() {
    if (!this.opened || this.stopped) return;
    await this.call('rescan').catch(() => {}); // the worker reports a failed scan as an error status
  }
  openInObsidian(path: string) {
    const a = document.createElement('a');
    a.href = `obsidian://open?vault=${encodeURIComponent(this.name)}&file=${encodeURIComponent(path.replace(/\.md$/i, ''))}`;
    a.rel = 'noopener';
    a.click();
  }
  stop() { this.stopped = true; this.worker.terminate(); this.fail(new Error('The vault was removed.')); }
}

let vaults: Vault[] = [];
// Vault management lives in the extension's settings page; it re-renders on every change.
const listeners = new Set<() => void>();
function changed() { listeners.forEach((fn) => fn()); }
function settingsVault(v: Vault): SettingsVault {
  const s = v.state;
  const status = s.kind === 'permission' ? 'Needs permission again'
    : s.kind === 'indexing' ? `Indexing${s.detail ? ` ${s.detail}` : '…'}`
    : s.kind === 'error' ? `Couldn't read: ${s.detail}`
    : `${v.notes || 'Ready'}${s.live ? '' : ' · not live'}`;
  return { id: v.id, name: v.name, status, needsPermission: s.kind === 'permission', reconnect: () => v.connect(true), remove: () => removeVault(v) };
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
const dropCache = (v: Vault) => deleteCache(v.id).catch((e) => console.warn('[roam-vaults] cache not cleared', e));
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
  renderPanel(panel, states);
}
function refreshAll() {
  document.querySelectorAll<HTMLElement>(`.rv-panel[${ATTR}]`).forEach(fill);
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
      if (panel && panel.dataset.title === title) continue;
      if (!panel) {
        panel = document.createElement('div');
        panel.setAttribute(ATTR, 'panel');
        panel.className = 'rv-panel';
        parent.insertBefore(panel, refs.nextSibling); // below Roam's own references
      }
      panel.dataset.title = title;
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
  workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));

  // No command palette entries (so no hotkeys either): vaults are managed in the settings panel.
  createSettingsPanel(extensionAPI, {
    vaults: () => vaults.map(settingsVault),
    add: addVault,
    rescan: () => vaults.forEach((v) => v.rescan()),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  });
  cleanups.push(() => listeners.clear());

  let frame = 0;
  const mo = new MutationObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(inject); });
  mo.observe(document.body, { childList: true, subtree: true });
  cleanups.push(() => { mo.disconnect(); cancelAnimationFrame(frame); });
  const onHash = () => requestAnimationFrame(inject);
  window.addEventListener('hashchange', onHash);
  cleanups.push(() => window.removeEventListener('hashchange', onHash));

  const saved = await loadVaults().catch(() => []);
  if (load !== loads) return; // unloaded while the saved vaults were being read
  vaults = saved.map((x) => new Vault(x.id, x.handle));
  changed();
  inject();
  await Promise.all(vaults.map((v) => v.connect(false)));
}

function onunload() {
  loads++;
  cleanups.splice(0).forEach((f) => f());
  vaults.forEach((v) => v.stop()); vaults = [];
  URL.revokeObjectURL(workerUrl);
  closeViewer();
  removeToast();
  document.querySelectorAll(`[${ATTR}]`).forEach((n) => n.remove());
}

export default { onload, onunload };
