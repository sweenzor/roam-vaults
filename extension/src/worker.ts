// Indexer Web Worker. Loaded from a Blob URL of this bundled file. Owns the vault
// directory handle, the index, the IndexedDB parse cache and the file watcher.
import { VaultEngine, inFolder, type VaultFS, type FileMeta, type Cache } from './engine.ts';
import { readNotes, writeNotes, deleteNotes } from './cache-db.ts';
import { intern } from './core/parser.ts';
import { NONE } from './core/vault-index.ts';
import { VaultIgnore, GITIGNORE } from './core/ignore.ts';
import { openDb } from './sql/db.ts';
import { SqlIndex } from './sql/sql-index.ts';
import type { Note } from './core/types.ts';

declare const self: DedicatedWorkerGlobalScope;
declare const FileSystemObserver: any;

let root: FileSystemDirectoryHandle | null = null;
let engine: VaultEngine | null = null;
let vaultKey = '';
let observer: any = null;
// Folder handles by path ('' is the vault itself). A handle per note would be tens of thousands
// of live handles in a big vault, each one costing memory in Roam's main process as well as here.
let dirs = new Map<string, FileSystemDirectoryHandle>();
// Paths are kept in NFC. The few files whose name on disk is written differently (decomposed
// accents, common in folders that came from a Mac) are looked up by that name.
let diskNames = new Map<string, string>();
// What the vault's .gitignore files and Obsidian's Excluded files leave out, as of the last scan.
let rules = new VaultIgnore();
// The index in SQLite, when the page handed over SQLite's compiled wasm: kept in the origin private
// file system across starts, so it is also the parse cache and the IndexedDB one is not used.
let store: SqlIndex | null = null;
let formatsUsed = '';
let live = false;      // is the file watcher running?
let notLiveWhy = '';

const post = (msg: unknown) => self.postMessage(msg);
let shown = ''; // the state last reported
const status = (state: string, detail = '') => { shown = state; post({ type: 'status', state, detail, live, notLiveWhy }); };
const noteCount = (n: number) => `${n} ${n === 1 ? 'note' : 'notes'}`;

// ---------- keeping file handles from piling up ----------
// A file handle or File object is released when the garbage collector gets to it, and the
// collector can't see what one costs: about 10 KB, most of it outside this worker, part of it in
// Roam's main process. Walking a 20,000-note vault makes over 40,000 of them and hardly any
// JavaScript garbage, so none were collected until well after the scan: about 400 MB at the peak.
// A large buffer that is never written to takes no real memory but counts as allocation, which
// brings the next collection forward. Measured with test/memory-bench.mjs (see DEVELOPING.md).
const HANDLES_PER_NUDGE = 2000, NUDGE_BYTES = 64 << 20;
let handlesMade = 0;
function madeHandles(n: number) {
  if ((handlesMade += n) < HANDLES_PER_NUDGE) return;
  handlesMade = 0;
  try { new ArrayBuffer(NUDGE_BYTES); } catch { /* no room for one: nothing is lost */ }
}

// ---------- file system over a FileSystemDirectoryHandle ----------
async function getDir(path: string): Promise<FileSystemDirectoryHandle> {
  let dir = dirs.get(path);
  if (dir) return dir;
  dir = root!;
  let at = '';
  for (const p of path.split('/')) {
    at = at ? `${at}/${p}` : p;
    let next = dirs.get(at);
    if (!next) dirs.set(at, next = await dir.getDirectoryHandle(diskNames.get(at) ?? p));
    dir = next;
  }
  return dir;
}
async function getFile(path: string): Promise<File> {
  if (!root) throw new DOMException('missing', 'NotFoundError');
  const i = path.lastIndexOf('/');
  const dir = i < 0 ? root : await getDir(path.slice(0, i));
  madeHandles(2);
  return (await dir.getFileHandle(diskNames.get(path) ?? path.slice(i + 1))).getFile();
}

const handleFS: VaultFS = {
  async list(folder = '') {
    const out: FileMeta[] = [];
    const found = new Map<string, FileSystemDirectoryHandle>();
    const names = new Map<string, string>();
    const pending: Promise<void>[] = [];
    // A whole scan reads the rules afresh; one folder adds its own .gitignore files to those in use.
    const skip = folder ? rules : new VaultIgnore();
    if (!folder) skip.setObsidianFilters((await obsidianConfig('app.json'))?.userIgnoreFilters);
    async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
      // A folder's .gitignore applies to everything in it, so read it before the folder's entries.
      const gi = await textOf(dir, GITIGNORE);
      if (gi !== null) skip.addGitignore(prefix, gi);
      for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
        madeHandles(1);
        if (name.startsWith('.')) continue; // .obsidian, .trash, .git
        const rel = (prefix ? `${prefix}/${name}` : name).normalize('NFC');
        if (name !== name.normalize('NFC')) names.set(rel, name);
        // Left out folders are not walked at all, so they cost nothing.
        if (skip.ignores(rel, h.kind === 'directory')) continue;
        if (h.kind === 'directory') { found.set(rel, h as FileSystemDirectoryHandle); await walk(h as FileSystemDirectoryHandle, rel); }
        else if (!/\.md$/i.test(name)) out.push({ path: rel, size: 0, mtime: 0 }); // only notes need a size and time
        else {
          madeHandles(1);
          pending.push((h as FileSystemFileHandle).getFile().then(
            (f) => { out.push({ path: rel, size: f.size, mtime: f.lastModified }); },
            () => { out.push({ path: rel, size: -1, mtime: -1 }); }));
          if (pending.length >= 64) await Promise.all(pending.splice(0));
        }
      }
    }
    if (!folder) {
      await walk(root!, '');
      await Promise.all(pending);
      dirs = found; diskNames = names; rules = skip;
      return out;
    }
    // One folder. Handles kept for it and the folders inside may be for what was there before it
    // was moved or replaced, so they are looked up again.
    const inside = (p: string) => p === folder || p.startsWith(folder + '/');
    for (const p of [...dirs.keys()]) if (inside(p)) dirs.delete(p);
    for (const p of [...diskNames.keys()]) if (p.startsWith(folder + '/')) diskNames.delete(p);
    rules.forgetGitignores(folder);
    await walk(await getDir(folder), folder);
    await Promise.all(pending);
    for (const [p, h] of found) dirs.set(p, h);
    for (const [p, n] of names) diskNames.set(p, n);
    return out;
  },
  async readText(path) { return (await getFile(path)).text(); },
  async stat(path) {
    try { const f = await getFile(path); return { path, size: f.size, mtime: f.lastModified }; }
    catch { return null; }
  },
};

// ---------- IndexedDB parse cache ----------
async function loadCache(key: string): Promise<Cache> {
  const cache: Cache = new Map();
  try {
    await readNotes(key, (n) => {
      // A copy read back from the database has its own string for every link: share them again.
      const l = n.links;
      for (let i = 0; i < l.length; i += 2) l[i] = intern(l[i] as string);
      for (let i = 0; i < n.tags.length; i++) n.tags[i] = intern(n.tags[i]);
      if (!l.length) n.links = NONE;
      if (!n.tags.length) n.tags = NONE;
      if (!n.aliases.length) n.aliases = NONE;
      cache.set(n.path, n);
    });
  } catch { cache.clear(); /* the cache is only an optimisation */ }
  return cache;
}
let unsaved = new Map<string, Note | null>(); // changes the cache has not caught up with
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> = Promise.resolve();
/** Queue an engine's changes for the cache: only the notes that changed are written. */
function saveCacheSoon(from: VaultEngine) {
  for (const [path, note] of from.unsaved) unsaved.set(path, note);
  from.unsaved = new Map();
  if (!unsaved.size) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const changes = [...unsaved], key = vaultKey;
    unsaved = new Map();
    saving = saving.then(() => writeNotes(key, changes)).catch(() => { /* the cache is only an optimisation */ });
  }, 2000);
}

// ---------- vault settings ----------
/** The text of a file in a folder, or null if there is none. */
async function textOf(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try { madeHandles(2); return await (await (await dir.getFileHandle(name)).getFile()).text(); }
  catch { return null; }
}
/** One of Obsidian's settings files in .obsidian, parsed, or null. */
async function obsidianConfig(name: string): Promise<any> {
  try { return JSON.parse((await textOf(await root!.getDirectoryHandle('.obsidian'), name)) ?? 'null'); }
  catch { return null; }
}
/** Settings files whose change can change what is indexed or how: a scan reads them again. */
const SETTINGS = new Set(['.obsidian/app.json', '.obsidian/daily-notes.json']);
async function dailyFormats(): Promise<string[]> {
  const fmts = ['YYYY-MM-DD'];
  const f = (await obsidianConfig('daily-notes.json'))?.format;
  if (typeof f === 'string' && f.trim()) fmts.unshift(f.trim()); // else Obsidian's default format
  return [...new Set(fmts)];
}

// ---------- watcher ----------
let pendingPaths = new Set<string>();
// Folders to walk again, with where each one moved from, if it did.
let pendingFolders = new Map<string, string | undefined>();
let needRescan = false;
let rewatch = false;   // the watcher reported "errored": it has stopped and must be started again
let building = 0;      // scans in progress
let refreshing = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
/** In a dot-folder, or a dot-file: never indexed. */
const hidden = (path: string) => path.split('/').some((s) => s.startsWith('.'));
function onRecords(records: any[]) {
  for (const r of records) {
    const parts: string[] = r.relativePathComponents ?? [];
    const path = parts.join('/').normalize('NFC');
    const name = parts[parts.length - 1];
    if (name && name !== name.normalize('NFC')) diskNames.set(path, name);
    if (r.type === 'errored') rewatch = true;
    // Events were lost somewhere in the vault, or the watcher stopped: walk the whole vault.
    if (r.type === 'errored' || (r.type === 'unknown' && !path)) { needRescan = true; continue; }
    if (!path) continue;
    // A folder appeared, went away or moved, or events inside it were lost: walk just that folder.
    // A folder that appears may bring notes that get no events of their own.
    const isDir = r.type === 'unknown' || r.changedHandle?.kind === 'directory' || !/\.[^/]+$/.test(path);
    // An ignore file or a settings file changed: which files are in the index, or how they are read, may have too.
    const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    if (SETTINGS.has(path) || (name === GITIGNORE && !isDir && !hidden(dir) && !(dir && rules.ignoresAnywhere(dir, true)))) {
      needRescan = true; continue;
    }
    let from = r.type === 'moved' && r.relativePathMovedFrom ? r.relativePathMovedFrom.join('/').normalize('NFC') : undefined;
    if (from !== undefined && (!from || hidden(from) || rules.ignoresAnywhere(from, isDir))) from = undefined;
    if (hidden(path) || rules.ignoresAnywhere(path, isDir)) {
      // Moved out of the index's reach, such as into .trash: it is gone from the vault.
      if (from !== undefined) { if (isDir) pendingFolders.set(from, pendingFolders.get(from)); else pendingPaths.add(from); }
      continue;
    }
    if (isDir) { pendingFolders.set(path, from ?? pendingFolders.get(path)); continue; }
    if (from !== undefined) pendingPaths.add(from);
    pendingPaths.add(path);
  }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 300); // editors write files in bursts
}
async function flush() {
  if (!root) return;
  // A scan or an earlier change is running: keep the changes and apply them after it.
  if (building || refreshing) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 300); return; }
  if (needRescan || !engine) {
    needRescan = false; pendingPaths = new Set(); pendingFolders = new Map();
    if (rewatch) { rewatch = false; await watch(); }
    await scan().catch(() => {}); // build() has already reported the failure
    return;
  }
  // Checked again here: changes seen while the first scan ran came in before its rules were read.
  const folders: { path: string; from?: string }[] = [];
  for (const [path, from] of pendingFolders) {
    if (!rules.ignoresAnywhere(path, true)) folders.push({ path, from });
    else if (from !== undefined) folders.push({ path: from }); // moved somewhere ignored: gone
  }
  // A note in a folder being walked is checked by the walk.
  const walked = new Set(folders.map((f) => f.path));
  const paths = [...pendingPaths].filter((p) => !inFolder(p, walked) && !rules.ignoresAnywhere(p, false));
  pendingPaths = new Set(); pendingFolders = new Map();
  const e = engine;
  refreshing = true;
  let changed = false;
  try {
    if (folders.length && await e.refreshFolders(folders)) changed = true;
    if (await e.refresh(paths)) changed = true;
  } finally { refreshing = false; }
  if (!changed || e !== engine) return;
  if (!store) saveCacheSoon(e);
  if (shown === 'ready') status('ready', noteCount(e.idx.noteCount()));
  post({ type: 'changed', paths: [...paths, ...folders.map((f) => f.path)] });
}
/** Start the file watcher. Whether it is running goes out with every status message. */
async function watch() {
  observer?.disconnect();
  observer = null; live = false;
  if (typeof FileSystemObserver === 'undefined') { notLiveWhy = 'FileSystemObserver unavailable'; return; }
  try {
    const o = new FileSystemObserver(onRecords);
    await o.observe(root, { recursive: true });
    observer = o; live = true; notLiveWhy = '';
  } catch (e) { notLiveWhy = (e as Error).message; }
}

// ---------- commands ----------
async function build() {
  building++;
  status('indexing', 'reading files');
  try {
    if (!root) throw new Error('The vault is not connected.');
    // The index in use stays in place until the new one is complete. Its notes are the cache
    // for the new one; only the first scan reads the saved cache.
    const formats = await dailyFormats();
    const progress = (done: number, total: number) => status('indexing', `${done} of ${total} notes`);
    let next: VaultEngine, stats;
    if (store) {
      // One index, updated in place. A new daily format needs a new matcher.
      if (engine && formatsUsed === JSON.stringify(formats)) next = engine;
      else { engine?.matcher?.detach(); next = new VaultEngine(handleFS, formats, store); formatsUsed = JSON.stringify(formats); }
      stats = await next.build(undefined, progress);
    } else {
      next = new VaultEngine(handleFS, formats);
      stats = await next.build(engine ? engine.cache : await loadCache(vaultKey), progress);
      saveCacheSoon(next);
    }
    engine = next;
    status('ready', noteCount(stats.notes));
    post({ type: 'changed', paths: [] });
    return stats;
  } catch (e) {
    // Say so, or the vault would stay "indexing" for good (folder moved, deleted or unmounted).
    status('error', `${(e as Error).name}: ${(e as Error).message}`);
    throw e;
  } finally { building--; }
}

// One scan at a time. Requests that come in while one runs share a single scan after it, so
// clicking Rescan repeatedly doesn't hold several new indexes in memory at once.
type Scan = ReturnType<typeof build>;
let running: Scan | null = null;
let queued: Scan | null = null;
function scan(): Scan {
  if (!running) {
    const p = build().finally(() => { if (running === p) running = null; });
    return running = p;
  }
  return queued ??= running.catch(() => {}).then(() => { queued = null; return scan(); });
}

const commands: Record<string, (a: any) => Promise<unknown> | unknown> = {
  async open({ handle, key, wasm }) {
    if (key !== vaultKey) { engine = null; unsaved = new Map(); store?.close(); store = null; }
    if (wasm && !store) {
      try {
        const o = await openDb(key, wasm);
        store = new SqlIndex(o.db);
        if (!o.persistent) console.warn('[roam-vaults] index kept in memory:', o.why);
        // The database is the cache now: what the in-memory index kept in IndexedDB goes.
        else deleteNotes(key).catch(() => { /* the cache is only an optimisation */ });
      } catch (e) { console.warn('[roam-vaults] SQLite unavailable, using the in-memory index', e); }
    }
    root = handle; vaultKey = key; dirs = new Map(); diskNames = new Map(); rules = new VaultIgnore();
    await watch(); // before the scan, so a file edited while it runs is not missed
    return scan();
  },
  rescan: () => scan(),
  query: ({ title }) => engine ? engine.query(title) : null,
  read: ({ path }) => engine!.read(path),
  resolve: ({ target, from }) => engine?.resolve(target, from) ?? null,
  close() { observer?.disconnect(); observer = null; engine = null; root = null; store?.close(); store = null; return true; },
};

self.onmessage = async ({ data }) => {
  const { id, cmd, args } = data;
  try { post({ id, ok: true, result: await commands[cmd](args ?? {}) }); }
  catch (e) { post({ id, ok: false, error: `${(e as Error).name}: ${(e as Error).message}` }); }
};
