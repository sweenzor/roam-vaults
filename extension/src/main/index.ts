// External Vault References: shows notes from local Markdown vaults (Obsidian) that match or
// link to the Roam page you are on. Read-only; nothing is written to the graph; no network.
import { loadVaults, saveVaults } from './store.ts';
import { pickVaultFolder, ensurePermission } from './picker.ts';
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

  constructor(id: string, handle: FileSystemDirectoryHandle) {
    this.id = id; this.handle = handle; this.name = handle.name;
    this.worker = new Worker(workerUrl);
    this.worker.onmessage = ({ data }) => {
      if (data.id !== undefined) {
        const w = this.waiting.get(data.id); this.waiting.delete(data.id);
        if (data.ok) w?.res(data.result); else w?.rej(new Error(data.error));
      } else if (data.type === 'status') this.onStatus(data.state, data.detail);
      else if (data.type === 'changed') { this.results.clear(); refreshAll(); }
    };
    this.worker.onerror = (e) => this.set({ kind: 'error', detail: e.message || 'indexer crashed' });
    const viewer: ViewerActions = {
      read: (path) => this.call<string>('read', { path }),
      resolve: (target, from) => this.call<string | null>('resolve', { target, from }),
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
  set(s: SectionState) { this.state = s; this.results.clear(); refreshAll(); }
  private onStatus(s: string, detail: string) {
    if (s === 'indexing') this.set({ kind: 'indexing', detail });
    else if (s === 'ready') {
      const live = !detail.startsWith('no live updates');
      if (!live) console.warn('[roam-vaults]', this.name, detail);
      this.set({ kind: 'ready', result: null, live });
    }
  }
  async connect(ask: boolean) {
    if (!(await ensurePermission(this.handle, ask))) { this.set({ kind: 'permission' }); return; }
    this.set({ kind: 'indexing', detail: '' });
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
      r = await this.call<PageResult | null>('query', { title }).catch(() => null);
      this.results.set(title, r);
    }
    return r;
  }
  openInObsidian(path: string) {
    const a = document.createElement('a');
    a.href = `obsidian://open?vault=${encodeURIComponent(this.name)}&file=${encodeURIComponent(path.replace(/\.md$/i, ''))}`;
    a.rel = 'noopener';
    a.click();
  }
  stop() { this.worker.terminate(); this.waiting.clear(); }
}

let vaults: Vault[] = [];
const save = () => saveVaults(vaults.map((v) => ({ id: v.id, handle: v.handle }))).catch((e) => console.warn('[roam-vaults]', e));

async function addVault() {
  const h = await pickVaultFolder();
  if (!h) return;
  for (const v of vaults) if (await v.handle.isSameEntry(h)) { notify(`"${h.name}" is already added.`); return; }
  let id = h.name, n = 2;
  while (vaults.some((v) => v.id === id)) id = `${h.name} (${n++})`;
  const v = new Vault(id, h);
  vaults.push(v);
  await save();
  await v.connect(false);
  notify(`Added external vault "${h.name}".`);
}
async function removeVault(v: Vault) {
  v.stop();
  vaults = vaults.filter((x) => x !== v);
  await save();
  refreshAll();
  notify(`Removed external vault "${v.name}". The folder itself is untouched.`);
}
async function removeAll() {
  vaults.forEach((v) => v.stop());
  vaults = [];
  await save();
  refreshAll();
  notify('Removed all external vaults.');
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
async function fill(panel: HTMLElement) {
  const title = panel.dataset.title!;
  const snapshot = vaults.slice();
  const states = await Promise.all(snapshot.map(async (v): Promise<PanelVault> =>
    v.state.kind === 'ready' ? { id: v.id, name: v.name, act: v.act, state: { ...v.state, result: await v.query(title) } } : v));
  if (panel.dataset.title !== title || !panel.isConnected) return;
  renderPanel(panel, states, addVault);
}
function refreshAll() {
  document.querySelectorAll<HTMLElement>(`.rv-panel[${ATTR}]`).forEach(fill);
}

let scanning = false;
async function inject() {
  if (scanning) return;
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
}

// ---------- lifecycle ----------
const cleanups: (() => void)[] = [];

async function onload({ extensionAPI }: { extensionAPI: any }) {
  cleanups.push(installStyles());
  workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));

  const cmds: [string, () => void][] = [
    ['External Vault References: Add vault folder', addVault],
    ['External Vault References: Rescan vaults', () => vaults.forEach((v) => v.call('rescan').catch((e) => notify(e.message, 'error')))],
    ['External Vault References: Remove all vaults', removeAll],
  ];
  for (const [label, callback] of cmds) {
    extensionAPI.ui.commandPalette.addCommand({ label, callback });
    cleanups.push(() => extensionAPI.ui.commandPalette.removeCommand({ label }));
  }

  let frame = 0;
  const mo = new MutationObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(inject); });
  mo.observe(document.body, { childList: true, subtree: true });
  cleanups.push(() => { mo.disconnect(); cancelAnimationFrame(frame); });
  const onHash = () => requestAnimationFrame(inject);
  window.addEventListener('hashchange', onHash);
  cleanups.push(() => window.removeEventListener('hashchange', onHash));

  const saved = await loadVaults().catch(() => []);
  vaults = saved.map((x) => new Vault(x.id, x.handle));
  inject();
  await Promise.all(vaults.map((v) => v.connect(false)));
}

function onunload() {
  cleanups.splice(0).forEach((f) => f());
  vaults.forEach((v) => v.stop()); vaults = [];
  URL.revokeObjectURL(workerUrl);
  closeViewer();
  removeToast();
  document.querySelectorAll(`[${ATTR}]`).forEach((n) => n.remove());
}

export default { onload, onunload };
