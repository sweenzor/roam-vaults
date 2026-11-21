// Ties the graph scan, the device store and the All Files view together.
import { type FileEntry, type Row } from './files.ts';
import { scanGraph } from './scan.ts';
import { getMeta, putMeta, getSeen, putSeen, forget, fetchMeta, type Meta, type Seen } from './store.ts';
import { FilesView, defaultState, type ViewState } from './view.ts';
import { kindOf, extOf, storedName } from './files.ts';

export const VIEW_ID = 'roam-file-manager';
const api = () => (window as any).roamAlphaAPI;
const graphName = (): string => api().graph.name;
/** Files uploaded to this graph live under imgs/app/<graph>/. Only those can be unused or deleted:
 *  a file pasted from another graph belongs to that graph. */
const ownPrefix = () => `imgs/app/${graphName()}/`;

const STATE_KEY = 'roam-file-manager:view';
function loadState(): ViewState {
  const s = defaultState();
  try {
    const v = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}');
    if (v.sort) s.sort = v.sort;
    if (typeof v.desc === 'boolean') s.desc = v.desc;
    if (Array.isArray(v.hidden)) s.hidden = new Set(v.hidden);
  } catch { /* defaults */ }
  return s;
}
function saveState(s: ViewState) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ sort: s.sort, desc: s.desc, hidden: [...s.hidden] })); } catch { /* private mode */ }
}

export class App {
  private meta = new Map<string, Meta>();
  private view: FilesView | null = null;
  private rows: Row[] = [];
  private fetching: AbortController | null = null;
  private scanning: Promise<void> | null = null;

  /** Scans the graph, records what it found as seen, and builds the rows. */
  scan(): Promise<void> {
    return this.scanning ??= this.doScan().finally(() => { this.scanning = null; });
  }

  private async doScan() {
    const graph = graphName(), own = ownPrefix(), now = Date.now();
    const files = await scanGraph();
    const seen = await getSeen(graph).catch(() => [] as Seen[]);
    const seenBy = new Map(seen.map((s) => [s.key, s]));
    const updates: Seen[] = [];
    for (const f of files.values()) {
      if (!f.key.startsWith(own)) continue;
      const prev = seenBy.get(f.key);
      updates.push({ id: `${graph}|${f.key}`, graph, key: f.key, url: f.url, name: f.name, added: prev?.added || f.added, lastUsed: now, lastPage: f.uses[0]?.pageTitle ?? '' });
    }
    await putSeen(updates).catch(() => {});
    const unused: FileEntry[] = seen.filter((s) => !files.has(s.key)).map((s) => {
      const ext = extOf(s.key);
      return { key: s.key, url: s.url, name: s.name, ext, kind: kindOf(ext), added: s.added, uses: [] };
    });
    const all = [...files.values(), ...unused];
    const missing = all.map((f) => f.key).filter((k) => !this.meta.has(k));
    if (missing.length) for (const [k, v] of await getMeta(missing).catch(() => new Map<string, Meta>())) this.meta.set(k, v);
    const lastUsed = new Map(seen.map((s) => [s.key, s.lastUsed]));
    this.rows = all.map((f) => this.toRow(f, !files.has(f.key), lastUsed.get(f.key) ?? 0));
  }

  private toRow(f: FileEntry, unused: boolean, lastUsed: number): Row {
    const r: Row = { ...f, size: null, unused, lastUsed };
    this.applyMeta(r);
    return r;
  }

  private applyMeta(r: Row) {
    const m = this.meta.get(r.key);
    if (!m) return;
    r.size = m.size;
    if (m.created) r.added = m.created;
    if (m.fileName && r.name === storedName(r.key)) r.name = m.fileName;
  }

  /** Fetches storage metadata for rows that have none, a few at a time, updating the view as it goes. */
  private async fillMeta() {
    this.fetching?.abort();
    const ctl = this.fetching = new AbortController();
    // what is on screen first, then the rest in the order of the list
    const todo = new Map((this.view?.order() ?? this.rows).filter((r) => !this.meta.has(r.key)).map((r) => [r.key, r]));
    const next = (): Row | undefined => {
      for (const k of this.view?.inView() ?? []) { const r = todo.get(k); if (r) { todo.delete(k); return r; } }
      for (const [k, r] of todo) { todo.delete(k); return r; }
    };
    let pending: [string, Meta][] = [], last = Date.now();
    const flush = async (force = false) => {
      if (!pending.length || (!force && Date.now() - last < 400)) return;
      const batch = pending; pending = []; last = Date.now();
      const keys = new Set(batch.map(([k]) => k));
      for (const r of this.rows) if (keys.has(r.key)) this.applyMeta(r);
      this.view?.updated();
      await putMeta(batch).catch(() => {});
    };
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (let r = next(); r && !ctl.signal.aborted; r = next()) {
        try {
          const m = await fetchMeta(r.url, ctl.signal);
          if (m) { this.meta.set(r.key, m); pending.push([r.key, m]); }
        } catch { /* offline or aborted: try again next time */ }
        await flush();
      }
    }));
    if (!ctl.signal.aborted) await flush(true);
  }

  /** Builds the view for the main window and starts filling it. */
  mount(host: HTMLElement) {
    const state = loadState();
    this.view = new FilesView({
      openFile: (r) => window.open(r.url, '_blank', 'noopener'),
      openUse: (r, inSidebar) => this.openUse(r, inSidebar),
      deleteFiles: (rows) => this.deleteFiles(rows),
      dateTitle: (ms) => api().util.dateToPageTitle(new Date(ms)),
      stateChanged: () => saveState(state),
    }, state);
    host.append(this.view.el);
    if (this.rows.length) this.view.setRows(this.rows);
    this.scan().then(() => { this.view?.setRows(this.rows); return this.fillMeta(); }).catch((e) => console.warn('[roam-file-manager]', e));
  }

  get mounted() { return !!this.view; }

  unmount() {
    this.fetching?.abort(); this.fetching = null;
    this.view?.destroy(); this.view = null;
  }

  private openUse(r: Row, inSidebar: boolean) {
    const use = r.uses[0];
    if (!use) return;
    if (inSidebar) { api().ui.rightSidebar.addWindow({ window: { type: 'block', 'block-uid': use.uid } }); return; }
    // the list is a main-window component: close it, or it stays over the block
    api().ui.mainWindow.closeComponent(VIEW_ID);
    api().ui.mainWindow.openBlock({ block: { uid: use.uid } });
  }

  private async deleteFiles(rows: Row[]) {
    const own = ownPrefix(), graph = graphName();
    // look at the graph again first: a file that a block uses now is never deleted
    const current = await scanGraph();
    const gone: string[] = [], failed: Row[] = [];
    for (const r of rows) {
      if (!r.unused || !r.key.startsWith(own) || current.has(r.key)) continue;
      try {
        await api().file.delete({ url: r.url });
        gone.push(r.key);
      } catch (e) {
        // already gone from storage counts as deleted
        if (/not.?found|404|does not exist/i.test(String(e))) gone.push(r.key);
        else { failed.push(r); console.warn('[roam-file-manager] delete failed', r.key, e); }
      }
    }
    await forget(graph, gone).catch(() => {});
    for (const k of gone) this.meta.delete(k);
    await this.scan().catch(() => {});
    this.view?.setRows(this.rows);
    if (failed.length) errorToast(`Couldn't delete ${failed.map((r) => r.name).join(', ')}`);
  }
}

function errorToast(message: string) {
  const T = (window as any).Blueprint?.Core?.Toaster;
  if (!T) return;
  const t = T.create({ position: 'top' });
  t.show({ message, intent: 'danger', timeout: 6000 });
}
