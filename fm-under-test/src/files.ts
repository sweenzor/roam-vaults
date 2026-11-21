// Finds the files uploaded to Roam in a graph's blocks. Roam stores an upload in Firebase Storage
// and writes its download URL into the block that holds it, in one of a few forms:
//   ![](url)  {{[[pdf]]: url}}  {{pdf: url}}  {{[[video]]: url}}  {{[[audio]]: url}}  [name](url)
// A file is keyed by its storage path (imgs/app/<graph>/<id>.<ext>), so the same upload pasted with
// another token or in another form counts once. Pure functions, no DOM, so they run under node --test.

export type Kind = 'image' | 'pdf' | 'audio' | 'video' | 'other';

export interface Ref { url: string; label: string | null }

export interface Use {
  uid: string;          // the block that holds the file
  pageUid: string;
  pageTitle: string;
  time: number;         // the block's create time (ms), 0 when Roam has none
}

export interface FileEntry {
  key: string;          // storage path, e.g. imgs/app/my-graph/AbC123xyZ_.png
  url: string;          // a download URL as written in the graph
  name: string;         // the label it was uploaded with, else the stored file name
  ext: string;          // lower case, no dot
  kind: Kind;
  added: number;        // earliest create time of a block that holds it (ms), 0 when unknown
  uses: Use[];          // newest first
}

const URL_RE = /https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/\s]+\/o\/[^\s)}\]"'<>`]+/g;

/** Every Roam-hosted file URL in a block string, with the label of a [label](url) link. */
export function findRefs(text: string): Ref[] {
  const out: Ref[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0];
    const before = text.slice(0, m.index);
    // [label](url): the URL starts right after "](" and the matching "[" is on the same line,
    // and it isn't an image's ![](url)
    let label: string | null = null;
    if (before.endsWith('](')) {
      const open = before.lastIndexOf('[', before.length - 3);
      if (open >= 0 && before[open - 1] !== '!' && !before.slice(open, -2).includes('\n')) {
        label = before.slice(open + 1, -2).trim() || null;
      }
    }
    out.push({ url, label });
  }
  return out;
}

/** The storage path of a download URL, decoded (imgs/app/graph/id.ext), or null. */
export function storageKey(url: string): string | null {
  const m = url.match(/\/o\/([^?#]+)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/** Files in an encrypted graph are stored encrypted, with .enc after their own extension. */
export const isEncrypted = (key: string) => key.toLowerCase().endsWith('.enc');

export function extOf(key: string): string {
  let base = key.slice(key.lastIndexOf('/') + 1);
  if (isEncrypted(base)) base = base.slice(0, -4);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

const KINDS: Record<string, Kind> = {};
for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'heif', 'ico', 'tif', 'tiff']) KINDS[e] = 'image';
for (const e of ['mp3', 'wav', 'm4a', 'ogg', 'oga', 'flac', 'aac', 'opus', 'weba']) KINDS[e] = 'audio';
for (const e of ['mp4', 'mov', 'webm', 'm4v', 'mkv', 'avi', 'ogv']) KINDS[e] = 'video';
KINDS.pdf = 'pdf';

export const kindOf = (ext: string): Kind => KINDS[ext] ?? 'other';

/** The file name Roam stored: the last path segment. Roam prefixes a random 10-character id. */
export const storedName = (key: string) => key.slice(key.lastIndexOf('/') + 1);

export interface BlockRow { uid: string; text: string; time: number; pageUid: string; pageTitle: string }

/** Groups the files in `blocks` by storage path. Uses are newest first; files are not sorted. */
export function collect(blocks: Iterable<BlockRow>): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();
  for (const b of blocks) {
    const seen = new Set<string>();
    for (const r of findRefs(b.text)) {
      const key = storageKey(r.url);
      if (!key) continue;
      let f = files.get(key);
      if (!f) {
        const ext = extOf(key);
        f = { key, url: r.url, name: r.label ?? storedName(key), ext, kind: kindOf(ext), added: 0, uses: [] };
        files.set(key, f);
      } else if (r.label && f.name === storedName(key)) {
        f.name = r.label;
      }
      if (b.time && (!f.added || b.time < f.added)) f.added = b.time;
      if (!seen.has(key)) { seen.add(key); f.uses.push({ uid: b.uid, pageUid: b.pageUid, pageTitle: b.pageTitle, time: b.time }); }
    }
  }
  for (const f of files.values()) f.uses.sort((a, b) => b.time - a.time);
  return files;
}

export type SortKey = 'name' | 'kind' | 'size' | 'uses' | 'added';

export interface Row extends FileEntry { size: number | null; unused: boolean; lastUsed: number }

export function compare(key: SortKey, desc: boolean) {
  const dir = desc ? -1 : 1;
  return (a: Row, b: Row): number => {
    let d = 0;
    switch (key) {
      case 'name': d = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }); break;
      case 'kind': d = a.kind.localeCompare(b.kind) || a.ext.localeCompare(b.ext); break;
      case 'size': d = (a.size ?? -1) - (b.size ?? -1); break;
      case 'uses': d = a.uses.length - b.uses.length; break;
      case 'added': d = a.added - b.added; break;
    }
    return d * dir || (b.added - a.added) || a.key.localeCompare(b.key);
  };
}

export function formatSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
