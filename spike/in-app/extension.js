// §9 in-app spike for docs/FEASIBILITY.md. Throwaway. Load via Roam Depot developer mode.
// Every result goes to a floating panel, the console ("[vault-spike]") and localStorage
// ("vault-spike-log"), so it survives restarts and can be copied out.

const DB = 'vault-spike', STORE = 'handles', LOGKEY = 'vault-spike-log';
const cleanups = [];
let panel, logEl;

// ---------- logging ----------
function readLog() { try { return JSON.parse(localStorage.getItem(LOGKEY) || '[]'); } catch { return []; } }
function log(check, result, detail = '') {
  const entry = { t: new Date().toISOString(), check, result, detail: String(detail) };
  const all = readLog(); all.push(entry); localStorage.setItem(LOGKEY, JSON.stringify(all.slice(-300)));
  console.log('[vault-spike]', check, result, detail);
  render();
}
function render() {
  if (!logEl) return;
  logEl.textContent = readLog().slice(-40).map(e => `${e.t.slice(11, 19)}  ${e.check}: ${e.result}${e.detail ? '  ' + e.detail : ''}`).join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- IndexedDB ----------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbOp(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); res(req?.result); }; tx.onerror = () => rej(tx.error);
  });
}
const saveHandle = h => idbOp('readwrite', s => s.put(h, 'vault'));
const loadHandle = () => idbOp('readonly', s => s.get('vault'));

// ---------- check 1 + 3: pick, persist, permission ----------
async function pick() {
  if (!window.showDirectoryPicker) return log('1 pick', 'FAIL', 'showDirectoryPicker missing');
  try {
    const h = await window.showDirectoryPicker({ id: 'vault-spike', mode: 'read' });
    await saveHandle(h);
    log('1 pick', 'OK', `picked "${h.name}", stored; permission now=${await h.queryPermission({ mode: 'read' })}`);
  } catch (e) {
    // Picking ~/Documents itself is expected to land here (check 3).
    log('1/3 pick', 'ERROR', `${e.name}: ${e.message}`);
  }
}
async function checkPersisted(trigger) {
  const h = await loadHandle().catch(e => (log('1 persist', 'ERROR', e), null));
  if (!h) return log('1 persist', 'NO HANDLE', `(${trigger}) pick a folder first`);
  const p = await h.queryPermission({ mode: 'read' });
  log('1 persist', p === 'granted' ? 'PASS' : 'NOT GRANTED', `(${trigger}) "${h.name}" queryPermission=${p}`);
  return h;
}
async function requestPerm() {
  const h = await loadHandle();
  if (!h) return log('1 request', 'NO HANDLE');
  const t0 = performance.now();
  const p = await h.requestPermission({ mode: 'read' });
  log('1 request', p, `took ${Math.round(performance.now() - t0)} ms (≈0 ms means no dialog was shown)`);
}

// ---------- check 2: FileSystemObserver ----------
let observer;
async function observe() {
  const h = await checkPersisted('observer');
  if (!h) return;
  if (!('FileSystemObserver' in window)) return log('2 observer', 'FAIL', 'FileSystemObserver missing');
  observer?.disconnect();
  observer = new window.FileSystemObserver(records => {
    for (const r of records) log('2 observer', 'EVENT', `${r.type} ${(r.relativePathComponents || []).join('/')}`);
  });
  try {
    await observer.observe(h, { recursive: true });
    log('2 observer', 'WATCHING', 'now edit/create/rename a note in Obsidian; events should appear');
  } catch (e) { log('2 observer', 'ERROR', `${e.name}: ${e.message}`); }
}

// ---------- check 4: panel injection ----------
let mounts = 0;
function injectPanel() {
  const refs = document.querySelectorAll('.roam-article .rm-reference-main');
  refs.forEach(ref => {
    if (ref.parentElement.querySelector(':scope > [data-vault-spike]')) return;
    const box = document.createElement('div');
    box.dataset.vaultSpike = '1';
    box.style.cssText = 'border:2px dashed #8a5cf6;border-radius:6px;padding:6px 10px;margin:8px 0;color:#8a5cf6;font:12px system-ui';
    const title = document.querySelector('.roam-article .rm-title-display')?.textContent?.trim() || '(no title)';
    box.textContent = `Vault references (spike) for "${title}" · mount #${++mounts}`;
    ref.parentElement.insertBefore(box, ref);
  });
}
function startInjection() {
  let pending = 0;
  const mo = new MutationObserver(() => { cancelAnimationFrame(pending); pending = requestAnimationFrame(injectPanel); });
  mo.observe(document.body, { childList: true, subtree: true });
  injectPanel();
  cleanups.push(() => { mo.disconnect(); document.querySelectorAll('[data-vault-spike]').forEach(n => n.remove()); });
}

// ---------- check 5 + 6: Blob worker + cold scan ----------
const workerSrc = `
self.onmessage = async ({ data: { handle } }) => {
  const t0 = performance.now();
  const files = [];
  async function walk(dir, path) {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.')) continue;
      if (h.kind === 'directory') await walk(h, path + name + '/');
      else if (name.endsWith('.md')) files.push(h);
    }
  }
  try {
    await walk(handle, '');
    const tWalk = performance.now();
    let bytes = 0, errors = 0, i = 0;
    async function worker() {
      while (i < files.length) {
        const f = files[i++];
        try { bytes += (await (await f.getFile()).text()).length; } catch { errors++; }
      }
    }
    await Promise.all(Array.from({ length: 32 }, worker));
    self.postMessage({ ok: true, files: files.length, chars: bytes, errors,
      walkMs: Math.round(tWalk - t0), readMs: Math.round(performance.now() - tWalk) });
  } catch (e) { self.postMessage({ ok: false, error: e.name + ': ' + e.message }); }
};`;
async function scan() {
  const h = await checkPersisted('scan');
  if (h) scanWith(h);
}
function scanWith(h) {
  let w;
  try {
    w = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
    log('5 worker', 'STARTED', 'Blob worker created');
  } catch (e) { return log('5 worker', 'FAIL', `${e.name}: ${e.message}`); }
  w.onerror = e => log('5 worker', 'ERROR', e.message);
  w.onmessage = ({ data }) => {
    if (!data.ok) log('5 worker', 'ERROR', data.error);
    else {
      log('5 worker', 'PASS', 'received directory handle and read files');
      log('6 scan', 'DONE', `${data.files} .md files, ${(data.chars / 1e6).toFixed(1)}M chars, walk ${data.walkMs} ms, read ${data.readMs} ms (32 parallel), ${data.errors} read errors`);
    }
    w.terminate();
  };
  w.postMessage({ handle: h });
}

// ---------- UI ----------
function buildPanel() {
  panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;width:460px;background:#fff;color:#222;border:1px solid #ccc;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);font:12px system-ui';
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding:6px;border-bottom:1px solid #eee';
  const btn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.className = 'bp3-button bp3-small'; b.onclick = fn; bar.append(b); };
  btn('1 Pick vault', pick);
  btn('1 Check access', () => checkPersisted('button'));
  btn('1 Request', requestPerm);
  btn('2 Watch', observe);
  btn('5+6 Scan', scan);
  btn('Copy log', async () => { await navigator.clipboard.writeText(JSON.stringify(readLog(), null, 1)); log('log', 'COPIED'); });
  btn('Clear', () => { localStorage.removeItem(LOGKEY); render(); });
  btn('–', () => { logEl.hidden = !logEl.hidden; });
  logEl = document.createElement('pre');
  logEl.style.cssText = 'margin:0;padding:6px;max-height:240px;overflow:auto;white-space:pre-wrap;font:11px ui-monospace,monospace';
  panel.append(bar, logEl);
  document.body.append(panel);
  cleanups.push(() => panel.remove());
  render();
}

export const _test = { scanWith };

export default {
  onload: async () => {
    buildPanel();
    log('env', 'INFO', `${navigator.userAgent.match(/(Chrome|Electron)\/[\d.]+/g)?.join(' ')} desktop=${window.roamAlphaAPI?.platform?.isDesktop}`);
    await checkPersisted('onload');   // the key check: run this after a full Roam restart
    startInjection();
  },
  onunload: () => { observer?.disconnect(); cleanups.splice(0).forEach(f => f()); },
};
