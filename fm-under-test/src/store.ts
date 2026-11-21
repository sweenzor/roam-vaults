// What the extension keeps on this device, in IndexedDB (database "roam-file-manager"):
//  - meta: each file's Firebase Storage metadata (size, upload time, original name). It never
//    changes for a stored file, so it is fetched once.
//  - seen: every file of this graph the extension has found in a block, with when it last saw it in
//    use. Roam can't list a graph's stored files, so this is how a file that no block uses any more
//    is found: it was seen before and isn't in any block now.
export interface Meta { size: number; created: number; fileName: string | null; type: string | null }
export interface Seen { id: string; graph: string; key: string; url: string; name: string; added: number; lastUsed: number; lastPage: string }

const DB = 'roam-file-manager';
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('seen')) db.createObjectStore('seen', { keyPath: 'id' }).createIndex('graph', 'graph');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  });
}

export function closeStore() { dbp?.then((db) => db.close(), () => {}); dbp = null; }

const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function getMeta(keys: string[]): Promise<Map<string, Meta>> {
  const db = await open();
  const s = db.transaction('meta').objectStore('meta');
  const out = new Map<string, Meta>();
  await Promise.all(keys.map(async (k) => { const v = await req(s.get(k)); if (v) out.set(k, v as Meta); }));
  return out;
}

export async function putMeta(entries: [string, Meta][]) {
  if (!entries.length) return;
  const db = await open();
  const t = db.transaction('meta', 'readwrite');
  for (const [k, v] of entries) t.objectStore('meta').put(v, k);
  await done(t);
}

export async function getSeen(graph: string): Promise<Seen[]> {
  const db = await open();
  return req(db.transaction('seen').objectStore('seen').index('graph').getAll(graph)) as Promise<Seen[]>;
}

export async function putSeen(rows: Seen[]) {
  if (!rows.length) return;
  const db = await open();
  const t = db.transaction('seen', 'readwrite');
  for (const r of rows) t.objectStore('seen').put(r);
  await done(t);
}

export async function forget(graph: string, keys: string[]) {
  const db = await open();
  const t = db.transaction(['seen', 'meta'], 'readwrite');
  for (const k of keys) { t.objectStore('seen').delete(`${graph}|${k}`); t.objectStore('meta').delete(k); }
  await done(t);
}

/** Firebase Storage metadata for a download URL. The JSON endpoint is the URL without ?alt=media.
 *  'gone' when storage no longer has the file (it answers 403 for a deleted file, or 404). */
export async function fetchMeta(url: string, signal?: AbortSignal): Promise<Meta | 'gone' | null> {
  const r = await fetch(url.replace(/[?#].*$/, ''), { signal });
  if (r.status === 403 || r.status === 404) return 'gone';
  if (!r.ok) return null;
  const m = await r.json();
  return { size: +m.size || 0, created: Date.parse(m.timeCreated) || 0, fileName: m.metadata?.['file-name'] ?? null, type: m.contentType ?? null };
}
