// Indexer Web Worker. Loaded from a Blob URL of this bundled file. Owns the vault
// directory handle, the index, the IndexedDB parse cache and the file watcher.
import { VaultEngine, type VaultFS, type FileMeta, type Cache } from './engine.ts';

declare const self: DedicatedWorkerGlobalScope;
declare const FileSystemObserver: any;

const CACHE_DB = 'roam-vaults-cache', CACHE_STORE = 'vaults', CACHE_VERSION = 1;

let root: FileSystemDirectoryHandle | null = null;
let engine: VaultEngine | null = null;
let vaultKey = '';
let observer: any = null;
let fileHandles = new Map<string, FileSystemFileHandle>();

const post = (msg: unknown) => self.postMessage(msg);
const status = (state: string, detail = '') => post({ type: 'status', state, detail });

// ---------- file system over a FileSystemDirectoryHandle ----------
async function getFileHandle(path: string): Promise<FileSystemFileHandle | null> {
  const known = fileHandles.get(path);
  if (known) return known;
  if (!root) return null;
  try {
    const parts = path.split('/');
    let dir = root;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
    const h = await dir.getFileHandle(parts[parts.length - 1]);
    fileHandles.set(path, h);
    return h;
  } catch { return null; }
}

const handleFS: VaultFS = {
  async list() {
    const out: FileMeta[] = [];
    const handles = new Map<string, FileSystemFileHandle>();
    const pending: Promise<void>[] = [];
    async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
      for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
        if (name.startsWith('.')) continue; // .obsidian, .trash, .git
        const rel = (prefix ? `${prefix}/${name}` : name).normalize('NFC');
        if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle, rel);
        else {
          handles.set(rel, h as FileSystemFileHandle);
          pending.push((h as FileSystemFileHandle).getFile().then(
            (f) => { out.push({ path: rel, size: f.size, mtime: f.lastModified }); },
            () => { out.push({ path: rel, size: -1, mtime: -1 }); }));
          if (pending.length >= 64) await Promise.all(pending.splice(0));
        }
      }
    }
    await walk(root!, '');
    await Promise.all(pending);
    fileHandles = handles;
    return out;
  },
  async readText(path) {
    const h = await getFileHandle(path);
    if (!h) throw new DOMException('missing', 'NotFoundError');
    return (await h.getFile()).text();
  },
  async stat(path) {
    fileHandles.delete(path);
    const h = await getFileHandle(path);
    if (!h) return null;
    try { const f = await h.getFile(); return { path, size: f.size, mtime: f.lastModified }; }
    catch { fileHandles.delete(path); return null; }
  },
};

// ---------- IndexedDB parse cache ----------
function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(CACHE_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(CACHE_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function loadCache(key: string): Promise<Cache> {
  try {
    const db = await openDb();
    const rec: any = await new Promise((res, rej) => {
      const q = db.transaction(CACHE_STORE).objectStore(CACHE_STORE).get(key);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
    db.close();
    if (!rec || rec.v !== CACHE_VERSION) return new Map();
    return new Map(rec.entries);
  } catch { return new Map(); }
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveCacheSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!engine) return;
    try {
      const db = await openDb();
      await new Promise<void>((res, rej) => {
        const tx = db.transaction(CACHE_STORE, 'readwrite');
        tx.objectStore(CACHE_STORE).put({ v: CACHE_VERSION, entries: [...engine!.cache] }, vaultKey);
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
      db.close();
    } catch { /* the cache is only an optimisation */ }
  }, 2000);
}

// ---------- vault settings ----------
async function dailyFormats(): Promise<string[]> {
  const fmts = ['YYYY-MM-DD'];
  try {
    const cfg = await root!.getDirectoryHandle('.obsidian');
    const f = await (await cfg.getFileHandle('daily-notes.json')).getFile();
    const j = JSON.parse(await f.text());
    if (typeof j.format === 'string' && j.format.trim()) fmts.unshift(j.format.trim());
  } catch { /* no daily-notes config: Obsidian's default format */ }
  return [...new Set(fmts)];
}

// ---------- watcher ----------
let pendingPaths = new Set<string>();
let needRescan = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
function onRecords(records: any[]) {
  for (const r of records) {
    const path = (r.relativePathComponents ?? []).join('/').normalize('NFC');
    if (r.type === 'unknown' || r.type === 'errored') { needRescan = true; continue; }
    if (!path || path.split('/').some((s: string) => s.startsWith('.'))) continue;
    if (r.type === 'moved' && r.relativePathMovedFrom) pendingPaths.add(r.relativePathMovedFrom.join('/').normalize('NFC'));
    // A folder appeared, vanished or moved: simplest to rescan (cached notes are not re-read).
    if (r.changedHandle?.kind === 'directory' || !/\.[^/]+$/.test(path)) { needRescan = true; continue; }
    pendingPaths.add(path);
  }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 300); // editors write files in bursts
}
async function flush() {
  if (!engine) return;
  const paths = [...pendingPaths]; pendingPaths = new Set();
  let changed = false;
  if (needRescan) { needRescan = false; await build(); return; }
  changed = await engine.refresh(paths);
  if (changed) { saveCacheSoon(); post({ type: 'changed', paths }); }
}
async function watch() {
  observer?.disconnect();
  observer = null;
  if (typeof FileSystemObserver === 'undefined') { status('ready', 'no live updates: FileSystemObserver unavailable'); return; }
  try {
    observer = new FileSystemObserver(onRecords);
    await observer.observe(root, { recursive: true });
  } catch (e) { observer = null; status('ready', `no live updates: ${(e as Error).message}`); }
}

// ---------- commands ----------
async function build() {
  status('indexing', 'reading files');
  engine = new VaultEngine(handleFS, await dailyFormats());
  const stats = await engine.build(await loadCache(vaultKey), (done, total) => status('indexing', `${done} of ${total} notes`));
  saveCacheSoon();
  status('ready', `${stats.notes} ${stats.notes === 1 ? 'note' : 'notes'}`);
  post({ type: 'changed', paths: [] });
  return stats;
}

const commands: Record<string, (a: any) => Promise<unknown> | unknown> = {
  async open({ handle, key }) {
    root = handle; vaultKey = key; fileHandles = new Map();
    const stats = await build();
    await watch();
    return stats;
  },
  rescan: () => build(),
  query: ({ title }) => engine ? engine.query(title) : null,
  read: ({ path }) => engine!.read(path),
  resolve: ({ target, from }) => engine?.resolve(target, from) ?? null,
  close() { observer?.disconnect(); observer = null; engine = null; root = null; return true; },
};

self.onmessage = async ({ data }) => {
  const { id, cmd, args } = data;
  try { post({ id, ok: true, result: await commands[cmd](args ?? {}) }); }
  catch (e) { post({ id, ok: false, error: `${(e as Error).name}: ${(e as Error).message}` }); }
};
