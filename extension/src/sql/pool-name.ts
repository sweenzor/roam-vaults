// Where each vault's SQLite database lives in the origin private file system. Shared by the worker,
// which opens it, and the page, which deletes it when a vault is removed. No SQLite import here, so
// the page's bundle doesn't take the library in.

/** The folder all vaults' databases are in. */
export const SQL_DIR = '.roam-vaults';

/** A short, stable name for a vault, safe in a folder name: its database's folder and VFS name. */
export function poolName(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return 'rv-' + (h >>> 0).toString(36);
}
