// DOM pieces: styles, toasts, the "Vault references" panel and the read-only note viewer.
// Plain DOM with Blueprint 3 class names (Roam ships Blueprint), so no bundled UI library.
import type { PageResult } from '../engine.ts';
import { renderMarkdown, inline } from './markdown.ts';

export const ATTR = 'data-roam-vaults';

const CSS = `
.rv-panel{margin:12px 0 18px;border:1px solid rgba(138,92,246,.35);border-left:3px solid #8a5cf6;border-radius:6px;padding:8px 12px;font-size:14px;background:rgba(138,92,246,.04)}
.rv-head{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;color:#5c3bc4;font-weight:600}
.rv-head .rv-caret{width:12px;display:inline-block;transition:transform .1s}
.rv-panel.rv-collapsed .rv-caret{transform:rotate(-90deg)}
.rv-panel.rv-collapsed .rv-body{display:none}
.rv-head .rv-meta{font-weight:400;color:#8a8a99;font-size:12px}
.rv-head .rv-spacer{flex:1}
.rv-body{margin-top:6px}
.rv-sec{margin-top:8px}
.rv-sec-title{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#8a8a99;margin-bottom:4px}
.rv-row{display:flex;align-items:baseline;gap:8px;padding:2px 0;flex-wrap:wrap}
.rv-note{color:#106ba3;cursor:pointer;font-weight:500}
.rv-note:hover{text-decoration:underline}
.rv-path{color:#8a8a99;font-size:12px}
.rv-badge{font-size:11px;border-radius:3px;padding:0 5px;background:#ede7fd;color:#5c3bc4}
.rv-badge.rv-warn{background:#fdf0d5;color:#8a5a00}
.rv-lines{margin:0 0 6px 14px;padding-left:10px;border-left:2px solid #e5e5ea}
.rv-line{color:#333;font-size:13px;padding:1px 0;cursor:pointer;white-space:pre-wrap;word-break:break-word}
.rv-line:hover{background:rgba(138,92,246,.08)}
.rv-line .rv-wl{color:#106ba3}.rv-line .rv-tag{color:#5c3bc4}.rv-line code{font-size:12px}
.rv-empty{color:#8a8a99;font-size:13px}
.rv-link{font-size:12px;color:#8a8a99;cursor:pointer}
.rv-link:hover{color:#106ba3;text-decoration:underline}
.rv-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:30000;max-width:560px;padding:10px 14px;border-radius:6px;background:#30404d;color:#fff;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.25)}
.rv-toast.rv-error{background:#a82a2a}
.rv-overlay{position:fixed;inset:0;z-index:20000;background:rgba(16,22,26,.45);display:flex;align-items:center;justify-content:center}
.rv-viewer{background:#fff;color:#182026;width:min(760px,92vw);max-height:86vh;display:flex;flex-direction:column;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.3)}
.rv-viewer-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #e5e5ea}
.rv-viewer-head h3{margin:0;font-size:18px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rv-viewer-path{padding:4px 16px 0;color:#8a8a99;font-size:12px}
.rv-viewer-body{padding:8px 20px 20px;overflow:auto;font-size:14px;line-height:1.55}
.rv-viewer-body h1,.rv-viewer-body h2,.rv-viewer-body h3,.rv-viewer-body h4{margin:14px 0 6px}
.rv-viewer-body p{margin:4px 0}
.rv-viewer-body pre{background:#f5f8fa;padding:8px;border-radius:4px;overflow:auto;font-size:12px}
.rv-viewer-body code{background:#f5f8fa;padding:0 3px;border-radius:3px;font-size:12px}
.rv-viewer-body .rv-li{padding-left:calc(var(--d,0) * 18px + 14px);position:relative}
.rv-viewer-body .rv-li::before{content:'•';position:absolute;left:calc(var(--d,0) * 18px + 2px);color:#8a8a99}
.rv-viewer-body .rv-wl{color:#106ba3;cursor:pointer}
.rv-viewer-body .rv-wl.rv-missing{color:#8a8a99;cursor:default}
.rv-viewer-body .rv-tag{color:#5c3bc4}
.rv-viewer-body .rv-props{font-size:12px;color:#5c7080;background:#f5f8fa;border-radius:4px;padding:6px 10px;margin:8px 0}
.rv-viewer-body .rv-hl{background:#fff3b0;border-radius:3px}
.rv-viewer-body blockquote{border-left:3px solid #d8e1e8;margin:4px 0;padding-left:10px;color:#5c7080}
.bp3-dark .rv-panel{background:rgba(138,92,246,.08)}
.bp3-dark .rv-line{color:#ccc}
`;

export function installStyles(): () => void {
  const el = document.createElement('style');
  el.setAttribute(ATTR, 'style');
  el.textContent = CSS;
  document.head.append(el);
  return () => el.remove();
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c != null && c !== false) el.append(c);
  return el;
}

// ---------- toast ----------
let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string, kind: 'info' | 'error' = 'info', ms = 5000) {
  toastEl?.remove();
  clearTimeout(toastTimer);
  toastEl = h('div', { class: `rv-toast${kind === 'error' ? ' rv-error' : ''}`, [ATTR]: 'toast', onclick: () => toastEl?.remove() }, text);
  document.body.append(toastEl);
  toastTimer = setTimeout(() => toastEl?.remove(), ms);
}
export function removeToast() { toastEl?.remove(); clearTimeout(toastTimer); }

// ---------- panel ----------
export type PanelState =
  | { kind: 'none' }
  | { kind: 'permission'; vault: string }
  | { kind: 'indexing'; vault: string; detail: string }
  | { kind: 'error'; vault: string; detail: string }
  | { kind: 'ready'; vault: string; result: PageResult | null; live: boolean };

export interface PanelActions {
  choose(): void;
  reconnect(): void;
  view(path: string, line?: number): void;
  openInObsidian(path: string): void;
}

const COLLAPSE_KEY = 'roam-vaults:collapsed';
const collapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } };

export function renderPanel(el: HTMLElement, s: PanelState, act: PanelActions) {
  el.className = 'rv-panel' + (collapsed() ? ' rv-collapsed' : '');
  const toggle = () => {
    const now = !el.classList.contains('rv-collapsed');
    try { localStorage.setItem(COLLAPSE_KEY, now ? '1' : '0'); } catch { /* private mode */ }
    document.querySelectorAll<HTMLElement>(`.rv-panel[${ATTR}]`).forEach((p) => p.classList.toggle('rv-collapsed', now));
  };
  const btn = (label: string, fn: () => void) => h('button', { class: 'bp3-button bp3-small', onclick: (e: Event) => { e.stopPropagation(); fn(); } }, label);

  let meta = '';
  let body: HTMLElement;
  if (s.kind === 'none') {
    body = h('div', { class: 'rv-empty' }, 'Connect a folder of Markdown notes, such as an Obsidian vault, to see its notes about this page. ', btn('Choose vault folder', act.choose));
  } else if (s.kind === 'permission') {
    body = h('div', { class: 'rv-empty' }, `Roam needs permission to read "${s.vault}" again. `, btn('Reconnect', act.reconnect));
  } else if (s.kind === 'indexing') {
    meta = `${s.vault} · indexing ${s.detail}`;
    body = h('div', { class: 'rv-empty' }, 'Reading the vault…');
  } else if (s.kind === 'error') {
    meta = s.vault;
    body = h('div', { class: 'rv-empty' }, `Couldn't read the vault: ${s.detail} `, btn('Choose vault folder', act.choose));
  } else {
    const r = s.result;
    const n = r ? r.counterparts.length + r.backlinks.length + r.tagged.length : 0;
    meta = `${s.vault} · ${n ? `${n} note${n === 1 ? '' : 's'}` : 'nothing yet'}${s.live ? '' : ' · not live'}`;
    body = r && n ? resultBody(r, act) : h('div', { class: 'rv-empty' }, 'No vault notes match or link to this page.');
  }
  el.replaceChildren(
    h('div', { class: 'rv-head', onclick: toggle },
      h('span', { class: 'rv-caret' }, '▾'), 'Vault references', h('span', { class: 'rv-meta' }, meta), h('span', { class: 'rv-spacer' })),
    h('div', { class: 'rv-body' }, body),
  );
}

function resultBody(r: PageResult, act: PanelActions): HTMLElement {
  const out = h('div');
  const noteLink = (path: string, title: string, line?: number) =>
    h('span', { class: 'rv-note', title: path, onclick: () => act.view(path, line) }, title);
  const obsidian = (path: string) => h('span', { class: 'rv-link', title: 'Open this note in Obsidian', onclick: () => act.openInObsidian(path) }, 'Open in Obsidian');
  const folder = (path: string) => { const i = path.lastIndexOf('/'); return i < 0 ? null : h('span', { class: 'rv-path' }, path.slice(0, i)); };

  if (r.counterparts.length) {
    const ambiguous = r.counterparts.length > 1;
    out.append(h('div', { class: 'rv-sec' },
      h('div', { class: 'rv-sec-title' }, ambiguous ? `This page in the vault (${r.counterparts.length} candidates)` : 'This page in the vault'),
      ...r.counterparts.map((c) => h('div', { class: 'rv-row' },
        noteLink(c.path, c.title), folder(c.path),
        h('span', { class: 'rv-badge' + (c.how === 'case' ? ' rv-warn' : '') }, c.label),
        obsidian(c.path)))));
  }
  if (r.backlinks.length) {
    out.append(h('div', { class: 'rv-sec' },
      h('div', { class: 'rv-sec-title' }, `Linked from the vault (${r.backlinks.length})`),
      ...r.backlinks.map((b) => h('div', {},
        h('div', { class: 'rv-row' }, noteLink(b.path, b.title, b.lines[0]?.line), folder(b.path)),
        h('div', { class: 'rv-lines' }, ...b.lines.map((l) =>
          snippetEl(l.text, () => act.view(b.path, l.line), l.line)))))));
  }
  if (r.tagged.length) {
    out.append(h('div', { class: 'rv-sec' },
      h('div', { class: 'rv-sec-title' }, `Tagged in the vault (${r.tagged.length})`),
      ...r.tagged.map((t) => h('div', { class: 'rv-row' }, noteLink(t.path, t.title), folder(t.path), h('span', { class: 'rv-badge' }, `#${t.tag}`)))));
  }
  return out;
}

function snippetEl(text: string, onclick: () => void, line: number) {
  const el = h('div', { class: 'rv-line', title: `Line ${line + 1}`, onclick });
  if (text) inline(el, text); else el.append('(link)');
  return el;
}

// ---------- viewer ----------
export interface ViewerActions {
  read(path: string): Promise<string>;
  resolve(target: string, from: string): Promise<string | null>;
  openInObsidian(path: string): void;
}
let overlay: HTMLElement | null = null;
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeViewer(); } };
export function closeViewer() { overlay?.remove(); overlay = null; document.removeEventListener('keydown', onKey, true); }

export async function openViewer(path: string, line: number | undefined, act: ViewerActions) {
  closeViewer();
  const title = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const body = h('div', { class: 'rv-viewer-body' }, 'Loading…');
  overlay = h('div', { class: 'rv-overlay', [ATTR]: 'viewer', onclick: (e: Event) => { if (e.target === overlay) closeViewer(); } },
    h('div', { class: 'rv-viewer', role: 'dialog', 'aria-label': title },
      h('div', { class: 'rv-viewer-head' },
        h('h3', {}, title),
        h('button', { class: 'bp3-button bp3-small', onclick: () => act.openInObsidian(path) }, 'Open in Obsidian'),
        h('button', { class: 'bp3-button bp3-small bp3-minimal', 'aria-label': 'Close', onclick: closeViewer }, '✕')),
      h('div', { class: 'rv-viewer-path' }, path),
      body));
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  try {
    const text = await act.read(path);
    body.replaceChildren(renderMarkdown(text, line));
    body.querySelectorAll<HTMLElement>('.rv-wl[data-target]').forEach((a) => {
      a.addEventListener('click', async () => {
        const to = await act.resolve(a.dataset.target!, path);
        if (to) openViewer(to, undefined, act); else { a.classList.add('rv-missing'); a.title = 'No such note in the vault'; }
      });
    });
    body.querySelector('.rv-hl')?.scrollIntoView({ block: 'center' });
  } catch (e) {
    body.replaceChildren(`Couldn't read this note: ${(e as Error).message}`);
  }
}
