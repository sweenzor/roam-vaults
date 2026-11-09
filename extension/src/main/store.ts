// The connected vaults' directory handles, kept in this device's IndexedDB (never in
// Roam settings, which sync through the graph).
const DB = 'roam-vaults', STORE = 'handles', KEY = 'vaults', OLD_KEY = 'vault';
export interface SavedVault { id: string; handle: FileSystemDirectoryHandle }

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); res((req as IDBRequest | undefined)?.result); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}

/** Saved vaults, oldest first. Picks up the single vault saved by earlier versions. */
export async function loadVaults(): Promise<SavedVault[]> {
  const list = await run<SavedVault[] | undefined>('readonly', (s) => s.get(KEY));
  if (list) return list;
  const old = await run<FileSystemDirectoryHandle | undefined>('readonly', (s) => s.get(OLD_KEY));
  return old ? [{ id: old.name, handle: old }] : [];
}
export const saveVaults = (list: SavedVault[]) => run<void>('readwrite', (s) => { s.delete(OLD_KEY); return s.put(list, KEY); });

/** Delete a removed vault's parsed-note cache (written by the worker, keyed by vault id). */
export function deleteCache(id: string): Promise<void> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('roam-vaults-cache', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('vaults');
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction('vaults', 'readwrite');
      tx.objectStore('vaults').delete(id);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => { db.close(); rej(tx.error); };
    };
  });
}
