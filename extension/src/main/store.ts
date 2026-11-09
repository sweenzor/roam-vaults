// The connected vault's directory handle, kept in this device's IndexedDB (never in
// Roam settings, which sync through the graph).
const DB = 'roam-vaults', STORE = 'handles', KEY = 'vault';

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

export const loadVault = () => run<FileSystemDirectoryHandle | undefined>('readonly', (s) => s.get(KEY));
export const saveVault = (h: FileSystemDirectoryHandle) => run<void>('readwrite', (s) => s.put(h, KEY));
export const clearVault = () => run<void>('readwrite', (s) => s.delete(KEY));
