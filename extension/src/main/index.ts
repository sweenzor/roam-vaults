// Roam Vaults: shows notes from a local Markdown vault (Obsidian) that match or link to
// the Roam page you are on. Read-only; nothing is written to the graph; no network.
import { loadVault, saveVault, clearVault } from './store.ts';
import { pickVaultFolder, ensurePermission } from './picker.ts';
import { ATTR, installStyles, renderPanel, notify, removeToast, openViewer, closeViewer, type PanelState, type PanelActions, type ViewerActions } from './ui.ts';
import type { PageResult } from '../engine.ts';

declare const WORKER_SOURCE: string; // injected by build.mjs
declare global { interface Window { roamAlphaAPI: any } }

// ---------- worker client ----------
let worker: Worker | null = null;
let workerUrl = '';
let seq = 0;
const waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();

function startWorker() {
  workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  worker = new Worker(workerUrl);
  worker.onmessage = ({ data }) => {
    if (data.id !== undefined) {
      const w = waiting.get(data.id); waiting.delete(data.id);
      if (data.ok) w?.res(data.result); else w?.rej(new Error(data.error));
    } else if (data.type === 'status') onStatus(data.state, data.detail);
    else if (data.type === 'changed') refreshAll();
  };
  worker.onerror = (e) => setState({ kind: 'error', vault: vaultName, detail: e.message || 'indexer crashed' });
}
function call<T>(cmd: string, args?: unknown): Promise<T> {
  const id = ++seq;
  return new Promise((res, rej) => { waiting.set(id, { res, rej }); worker!.postMessage({ id, cmd, args }); });
}

// ---------- state ----------
let state: PanelState = { kind: 'none' };
let vaultName = '';
let live = true;
let handle: FileSystemDirectoryHandle | null = null;

function setState(s: PanelState) { state = s; refreshAll(); }
function onStatus(s: string, detail: string) {
  if (s === 'indexing') setState({ kind: 'indexing', vault: vaultName, detail });
  else if (s === 'ready') {
    live = !detail.startsWith('no live updates');
    if (!live) console.warn('[roam-vaults]', detail);
    setState({ kind: 'ready', vault: vaultName, result: null, live });
  }
}

async function connect(h: FileSystemDirectoryHandle, ask: boolean) {
  handle = h; vaultName = h.name;
  if (!(await ensurePermission(h, ask))) { setState({ kind: 'permission', vault: vaultName }); return; }
  setState({ kind: 'indexing', vault: vaultName, detail: '' });
  try {
    const stats: any = await call('open', { handle: h, key: h.name });
    if (stats.errors?.length) console.warn('[roam-vaults] unreadable files', stats.errors);
  } catch (e) {
    setState({ kind: 'error', vault: vaultName, detail: (e as Error).message });
  }
}

async function chooseVault() {
  const h = await pickVaultFolder();
  if (!h) return;
  await saveVault(h);
  await connect(h, false);
  notify(`Connected "${h.name}".`);
}
async function disconnect() {
  await call('close').catch(() => {});
  await clearVault();
  handle = null; vaultName = '';
  setState({ kind: 'none' });
  notify('Vault disconnected.');
}

function obsidianUrl(path: string) {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(path.replace(/\.md$/i, ''))}`;
}
function openInObsidian(path: string) {
  const a = document.createElement('a');
  a.href = obsidianUrl(path);
  a.rel = 'noopener';
  a.click();
}

const viewerActions: ViewerActions = {
  read: (path) => call<string>('read', { path }),
  resolve: (target, from) => call<string | null>('resolve', { target, from }),
  openInObsidian,
};
const panelActions: PanelActions = {
  choose: chooseVault,
  reconnect: () => { if (handle) connect(handle, true); },
  view: (path, line) => openViewer(path, line, viewerActions),
  openInObsidian,
};

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
const results = new Map<string, PageResult | null>();
async function fill(panel: HTMLElement) {
  const title = panel.dataset.title!;
  if (state.kind !== 'ready') { renderPanel(panel, state, panelActions); return; }
  let r = results.get(title);
  if (r === undefined) {
    renderPanel(panel, { ...state, result: null }, panelActions);
    r = await call<PageResult | null>('query', { title }).catch(() => null);
    results.set(title, r);
    if (panel.dataset.title !== title) return;
  }
  renderPanel(panel, { ...state, result: r }, panelActions);
}
function refreshAll() {
  results.clear();
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
        parent.insertBefore(panel, refs);
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
  startWorker();

  const cmds: [string, () => void][] = [
    ['Vault: Choose vault folder', chooseVault],
    ['Vault: Rescan vault', () => { if (state.kind !== 'none') call('rescan').catch((e) => notify(e.message, 'error')); }],
    ['Vault: Disconnect vault', disconnect],
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

  const saved = await loadVault().catch(() => undefined);
  if (saved) await connect(saved, false);
  inject();
}

function onunload() {
  cleanups.splice(0).forEach((f) => f());
  worker?.terminate(); worker = null;
  URL.revokeObjectURL(workerUrl);
  waiting.clear();
  closeViewer();
  removeToast();
  document.querySelectorAll(`[${ATTR}]`).forEach((n) => n.remove());
}

export default { onload, onunload };
