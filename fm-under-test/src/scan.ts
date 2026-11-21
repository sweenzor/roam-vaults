// Reads the graph: every block whose text holds a Roam-hosted file URL, with its page.
import { collect, type BlockRow, type FileEntry } from './files.ts';

const QUERY = `[:find ?uid ?s ?ct ?pu ?pt
  :where [?b :block/string ?s]
         [(clojure.string/includes? ?s "firebasestorage.googleapis.com")]
         [?b :block/uid ?uid]
         [(get-else $ ?b :create/time 0) ?ct]
         [?b :block/page ?p] [?p :block/uid ?pu] [?p :node/title ?pt]]`;

export async function scanGraph(): Promise<Map<string, FileEntry>> {
  const api = (window as any).roamAlphaAPI;
  const rows: [string, string, number, string, string][] = api.data.async?.q
    ? await api.data.async.q(QUERY) : api.data.q(QUERY);
  return collect(rows.map(([uid, text, time, pageUid, pageTitle]): BlockRow => ({ uid, text, time, pageUid, pageTitle })));
}

