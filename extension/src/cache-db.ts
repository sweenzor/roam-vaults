// The parsed-note cache in this device's IndexedDB, shared by the indexer workers (which read
// and write it) and the page (which deletes a removed vault's notes). One record per note,
// keyed by [vault id, path], so a changed note is one small write. Version 1 kept a whole
// vault in a single record and rewrote all of it after every change.
import type { Note } from './core/types.ts';

const DB = 'roam-vaults-cache', STORE = 'notes', VERSION = 3; // 3: OKF title and root on a note
const PAGE = 2000; // notes read or written per request, to keep the copies in flight small

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name); // older layouts
      db.createObjectStore(STORE);
    };
    r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); res(r.result); };
    r.onerror = () => rej(r.error);
  });
}
const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = tx.onabort = () => rej(tx.error); // abort: storage full, for example
});
const all = (vault: string, after?: string) =>
  IDBKeyRange.bound(after === undefined ? [vault] : [vault, after], [vault, []], after !== undefined);

/** Every cached note of a vault, handed over a page at a time. */
export async function readNotes(vault: string, each: (note: Note) => void): Promise<void> {
  const db = await open();
  try {
    for (let after: string | undefined; ;) {
      const page = await new Promise<Note[]>((res, rej) => {
        const q = db.transaction(STORE).objectStore(STORE).getAll(all(vault, after), PAGE);
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
      for (const n of page) if (typeof n?.path === 'string' && Array.isArray(n.links) && Array.isArray(n.tags) && Array.isArray(n.aliases)) each(n);
      if (page.length < PAGE) return;
      after = page[page.length - 1].path;
    }
  } finally { db.close(); }
}

/** Write changed notes and delete the ones whose value is null. */
export async function writeNotes(vault: string, changes: [path: string, note: Note | null][]): Promise<void> {
  const db = await open();
  try {
    for (let i = 0; i < changes.length; i += PAGE) {
      const tx = db.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE);
      for (const [path, note] of changes.slice(i, i + PAGE)) {
        if (note) store.put(note, [vault, path]); else store.delete([vault, path]);
      }
      await done(tx);
    }
  } finally { db.close(); }
}

/** Delete a removed vault's notes. */
export async function deleteNotes(vault: string): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(all(vault));
    await done(tx);
  } finally { db.close(); }
}
