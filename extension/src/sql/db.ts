// Opening the vault index's SQLite database, in the indexer worker.
//
// SQLite is the official WebAssembly build (@sqlite.org/sqlite-wasm). The .wasm is compiled once by
// the page from bytes inlined in extension.js (Roam Depot allows no code from the network) and
// handed to each worker. The database lives in the origin private file system through the
// "opfs-sahpool" VFS: one pool per vault, in its own folder, so vaults never share a lock. A pool
// can be held by one worker at a time, so a second Roam window open on the same vault gets a
// database in memory instead (persistent: false), which costs memory and starts from a full read.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { migrate } from './schema.ts';
import { SQL_DIR, poolName } from './pool-name.ts';

let ready: Promise<any> | null = null;
/** The SQLite library, started once per worker. */
export function sqlite(wasm?: WebAssembly.Module): Promise<any> {
  return ready ??= (sqlite3InitModule as any)({
    print: () => {}, printErr: () => {},
    // With a compiled module from the page there is nothing to fetch.
    ...(wasm ? {
      instantiateWasm(imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) {
        WebAssembly.instantiate(wasm, imports).then((i) => done(i, wasm));
        return {};
      },
    } : {}),
  });
}

export interface OpenDb { sqlite3: any; db: any; persistent: boolean; why: string }

export async function openDb(key: string, wasm?: WebAssembly.Module): Promise<OpenDb> {
  const sqlite3 = await sqlite(wasm);
  let db: any = null, persistent = false, why = '';
  if (sqlite3.installOpfsSAHPoolVfs) {
    // The pool's files can be held for a moment by a worker that is going away (the extension was
    // just reloaded), or for good by another Roam window: try a few times, then do without.
    const name = poolName(key);
    for (let attempt = 0; attempt < 4 && !db; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 250 * attempt));
      try {
        const pool = await sqlite3.installOpfsSAHPoolVfs({
          name, directory: `${SQL_DIR}/${name}`, initialCapacity: 4,
          preserveOnInitFailure: true, forceReinitIfPreviouslyFailed: true,
        });
        db = new pool.OpfsSAHPoolDb('/index.db');
        persistent = true;
      } catch (e) { why = (e as Error).message; }
    }
  } else why = 'opfs-sahpool unavailable';
  db ??= new sqlite3.oo1.DB(':memory:', 'c');
  // A cache of the vault: losing the last writes in a crash only means reading those notes again.
  db.exec(`PRAGMA journal_mode = ${persistent ? 'TRUNCATE' : 'OFF'}; PRAGMA synchronous = OFF; PRAGMA cache_size = -2048; PRAGMA temp_store = MEMORY;`);
  try { migrate(db); }
  catch {
    // A database this build can't read: start it again.
    db.exec(`PRAGMA writable_schema = 1; DELETE FROM sqlite_schema; PRAGMA writable_schema = 0; VACUUM; PRAGMA user_version = 0;`);
    migrate(db);
  }
  return { sqlite3, db, persistent, why };
}
