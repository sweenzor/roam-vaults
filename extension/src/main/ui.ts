// DOM pieces: styles, toasts, the "External Vault References" panel and the read-only note viewer.
// Plain DOM with Blueprint 3 class names (Roam ships Blueprint), so no bundled UI library.
import type { PageResult } from '../engine.ts';
import { renderMarkdown, inline } from './markdown.ts';

export const ATTR = 'data-roam-vaults';

const STYLES = `
.rv-panel{padding-top:12px;margin:0 -4px 0 -16px}
.rv-sec{margin-bottom:12px}
.rv-sec-head{display:flex;align-items:center;height:24px;gap:2px;cursor:pointer;user-select:none}
.rv-sec-head strong{color:rgb(206,217,224)}
.rv-sec-head .rv-head-caret{visibility:hidden}
.rv-sec-head:hover .rv-head-caret{visibility:visible;opacity:1}
.rv-meta{color:rgb(206,217,224);font-size:12px;margin-left:8px}
.rv-spacer{flex:1}
.rv-tool{visibility:hidden;color:#8a9ba8 !important;font-size:12px}
.rv-sec-head:hover .rv-tool{visibility:visible}
.rv-sec.rv-collapsed .rv-sec-body{display:none}
.rv-sec-body{margin-top:4px}
.rv-empty{color:#8a9ba8;font-size:13px;padding:2px 0 2px 16px}
.rv-group{margin-bottom:10px}
.rv-group-head{align-items:center;gap:2px;flex-wrap:wrap}
.rv-group-caret{cursor:pointer}
.rv-group-title{margin-right:8px}
.rv-note{cursor:pointer;color:rgb(51,122,183);font-size:16px;line-height:24px}
.rv-note:hover{text-decoration:underline}
.rv-vault{color:#8a9ba8}
.rv-panel .rv-wl,.rv-viewer .rv-wl{color:rgb(16,107,163);cursor:pointer}
.rv-panel .rv-wl:hover,.rv-viewer .rv-wl:hover,.rv-panel .rv-tag:hover,.rv-viewer .rv-tag:hover{text-decoration:underline}
.rv-br{color:rgb(167,182,194)}
.rv-panel .rv-tag,.rv-viewer .rv-tag,.rv-tagref{color:rgb(167,182,194);cursor:pointer}
.rv-tagref{font-size:14px;margin-right:8px}
.bp3-dark .rv-panel .rv-wl,.bp3-dark .rv-viewer .rv-wl{color:rgb(72,175,240)}
.rv-content{margin-left:20px}
.rv-block{display:flex;align-items:flex-start;cursor:pointer}
.rv-bullet{flex:0 0 auto;width:20px;height:28px;display:flex;align-items:center;justify-content:center}
.rv-bullet::before{content:'';width:6px;height:6px;border-radius:50%;background:rgb(57,75,89)}
.rv-block-text{flex:1;font-size:14px;line-height:21px;padding:4px 0;margin-top:-1px;color:rgb(32,43,51);white-space:pre-wrap;word-break:break-word}
.bp3-dark .rv-block-text{color:inherit}
.rv-block-text code{font-size:12px}
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
.rv-viewer-body .rv-wl.rv-missing{color:#8a8a99;cursor:default}
.rv-viewer-body .rv-props{font-size:12px;color:#5c7080;background:#f5f8fa;border-radius:4px;padding:6px 10px;margin:8px 0}
.rv-viewer-body .rv-hl{background:#fff3b0;border-radius:3px}
.rv-viewer-body blockquote{border-left:3px solid #d8e1e8;margin:4px 0;padding-left:10px;color:#5c7080}
.rv-viewer-body.rv-preview{padding:4px 12px 6px 20px;max-height:480px;overflow:auto}
.rv-viewer-body h2{font-size:20px}.rv-viewer-body h3{font-size:17px}.rv-viewer-body h4,.rv-viewer-body h5,.rv-viewer-body h6{font-size:15px}
.rv-preview h2,.rv-preview h3,.rv-preview h4{margin:8px 0 4px;font-weight:600}
.bp3-dark .rv-viewer-body.rv-preview{color:inherit}
.rv-settings{display:flex;flex-direction:column;gap:10px;min-width:280px}
.rv-settings-list{display:flex;flex-direction:column;gap:6px}
.rv-settings-row{display:flex;align-items:center;gap:8px}
.rv-settings-name{flex:1;font-weight:500}
.rv-settings-status{font-weight:400;font-size:12px;color:#8a9ba8}
.bp3-dark .rv-sec-head strong,.bp3-dark .rv-meta{color:#5c7080}
`;

export function installStyles(): () => void {
  const el = document.createElement('style');
  el.setAttribute(ATTR, 'style');
  el.textContent = STYLES;
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
// One panel per Roam reference area: a single "External Vault References" fold covering every
// connected vault. Laid out like Roam's own Linked References: a grey bold header with a
// caret, then one group per note (caret + vault/path title), and the note's lines as bullets.
export type SectionState =
  | { kind: 'permission' }
  | { kind: 'indexing'; detail: string }
  | { kind: 'error'; detail: string }
  | { kind: 'ready'; result: PageResult | null; live: boolean };

export interface SectionActions {
  reconnect(): void;
  remove(): void;
  view(path: string, line?: number): void;
  openInObsidian(path: string): void;
  read(path: string): Promise<string>;
  resolve(target: string, from: string): Promise<string | null>;
}
export interface PanelVault { id: string; name: string; state: SectionState; act: SectionActions }

const COLLAPSE_KEY = 'roam-vaults:collapsed';
const isCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } };
/** Note groups the user opened or closed, overriding the default. Kept across re-renders. */
const groupOpen = new Map<string, boolean>();

const caret = (open: boolean, extra = '') =>
  h('span', { class: `bp3-icon-standard bp3-icon-caret-down rm-caret ${open ? 'rm-caret-open' : 'rm-caret-closed'} ${extra}` });

export function renderPanel(el: HTMLElement, vaults: PanelVault[], add: () => void) {
  el.className = 'rv-panel';
  const tool = (label: string, title: string, fn: () => void) =>
    h('button', { class: 'bp3-button bp3-minimal bp3-small rv-tool', title, onclick: (e: Event) => { e.stopPropagation(); fn(); } }, label);
  if (!vaults.length) {
    el.replaceChildren(h('div', { class: 'rv-sec' },
      sectionHead('External Vault References', ''),
      h('div', { class: 'rv-sec-body' }, h('div', { class: 'rv-empty' },
        'Add a folder of Markdown notes, such as an Obsidian vault, to see its notes about this page. ',
        h('button', { class: 'bp3-button bp3-small', onclick: add }, 'Add vault folder')))));
    return;
  }
  // One fold for every vault. Vaults that aren't ready say so in a line of their own.
  const notices: HTMLElement[] = [];
  const ready: { v: PanelVault; r: PageResult }[] = [];
  let n = 0, notLive = false;
  for (const v of vaults) {
    const s = v.state;
    if (s.kind === 'permission') notices.push(h('div', { class: 'rv-empty' }, `Roam needs permission to read "${v.name}" again. `,
      h('button', { class: 'bp3-button bp3-small', onclick: v.act.reconnect }, 'Reconnect')));
    else if (s.kind === 'indexing') notices.push(h('div', { class: 'rv-empty' }, `Reading "${v.name}"… ${s.detail}`));
    else if (s.kind === 'error') notices.push(h('div', { class: 'rv-empty' }, `Couldn't read "${v.name}": ${s.detail}`));
    else {
      if (!s.live) notLive = true;
      if (s.result) {
        ready.push({ v, r: s.result });
        n += new Set([...s.result.counterparts, ...s.result.backlinks, ...s.result.tagged].map((x) => x.path)).size;
      }
    }
  }
  const body = h('div', { class: 'rv-sec-body' }, ...notices);
  if (n) body.append(resultBody(ready, vaults.length > 1));
  else if (!notices.length) body.append(h('div', { class: 'rv-empty' }, 'No vault notes match or link to this page.'));
  const collapsed = isCollapsed();
  el.replaceChildren(h('div', { class: 'rv-sec' + (collapsed ? ' rv-collapsed' : '') },
    sectionHead(`${n ? `${n} ` : ''}External Vault References`, notLive ? 'not live' : '', !collapsed,
      [tool('Add vault', 'Add another vault folder', add)]),
    body));
}

function sectionHead(label: string, meta: string, open = true, tools: HTMLElement[] = []) {
  const head = h('div', { class: 'rv-sec-head' },
    caret(open, 'rv-head-caret'),
    h('strong', {}, label),
    meta ? h('span', { class: 'rv-meta' }, meta) : null,
    h('span', { class: 'rv-spacer' }),
    ...tools);
  head.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const now = !isCollapsed();
    try { localStorage.setItem(COLLAPSE_KEY, now ? '1' : '0'); } catch { /* private mode */ }
    document.querySelectorAll<HTMLElement>(`.rv-panel[${ATTR}] .rv-sec`).forEach((s) => {
      s.classList.toggle('rv-collapsed', now);
      s.querySelector('.rv-head-caret')?.classList.replace(now ? 'rm-caret-open' : 'rm-caret-closed', now ? 'rm-caret-closed' : 'rm-caret-open');
    });
  });
  return head;
}

/** Notes from every ready vault: the notes that are this page first, then notes linking here,
 *  then notes only tagged here. With more than one vault, each title starts with its vault name. */
function resultBody(list: { v: PanelVault; r: PageResult }[], showVault: boolean): HTMLElement {
  const out = h('div', { class: 'rv-groups' });
  /** One note: caret + (vault/)path as a namespaced title (+ tag); content shows when open. Open in Obsidian lives in the viewer. */
  const group = (v: PanelVault, key: string, path: string, defOpen: boolean, extras: (Node | null)[], content: () => HTMLElement) => {
    const k = `${v.id}\n${key}\n${path}`;
    const box = h('div', { class: 'rv-content' });
    const c = caret(false, 'rm-caret-showing rv-group-caret');
    const set = (open: boolean) => {
      c.classList.toggle('rm-caret-open', open); c.classList.toggle('rm-caret-closed', !open);
      box.hidden = !open;
      if (open && !box.childNodes.length) box.append(content());
    };
    c.addEventListener('click', () => { const open = box.hidden; groupOpen.set(k, open); set(open); });
    set(groupOpen.get(k) ?? defOpen);
    return h('div', { class: 'rv-group' },
      h('div', { class: 'flex-h-box rv-group-head' }, c,
        h('div', { class: 'rm-ref-page-view-title rv-group-title' },
          h('span', { class: 'rv-note', title: `${v.name}/${path}`, onclick: () => v.act.view(path) },
            showVault ? h('span', { class: 'rv-vault' }, `${v.name}/`) : null, path.replace(/\.md$/i, ''))),
        ...extras),
      box);
  };
  // rm-reference-item: Roam's own grey reference background.
  const preview = (v: PanelVault, path: string) => () => { const el = h('div', { class: 'rv-viewer-body rv-preview rm-reference-item' }); loadPreview(el, path, v.act); return el; };

  // A note shows once: a tagged note that also links here gets the tag next to its title.
  const tagsOf = new Map(list.map(({ v, r }) => [v, new Map(r.tagged.map((t) => [t.path, t.tag]))]));
  const tagRef = (v: PanelVault, path: string) => {
    const tags = tagsOf.get(v)!, t = tags.get(path); tags.delete(path);
    return t ? h('span', { class: 'rv-tagref', title: 'Tagged with this page' }, `#${t}`) : null;
  };
  for (const { v, r } of list) for (const c of r.counterparts)
    out.append(group(v, 'page', c.path, false, [tagRef(v, c.path)], preview(v, c.path)));
  for (const { v, r } of list) for (const b of r.backlinks)
    out.append(group(v, 'links', b.path, true, [tagRef(v, b.path)],
      () => h('div', {}, ...b.lines.map((l) => blockEl(l.text, () => v.act.view(b.path, l.line), l.line)))));
  for (const { v, r } of list) for (const t of r.tagged) if (tagsOf.get(v)!.has(t.path))
    out.append(group(v, 'tag', t.path, false, [tagRef(v, t.path)], preview(v, t.path)));
  return out;
}

/** A linking line, drawn like a Roam block (bullet + text). Click opens the note at that line. */
function blockEl(text: string, onclick: () => void, line: number) {
  const t = h('div', { class: 'rv-block-text' });
  if (text) inline(t, text); else t.append('(link)');
  return h('div', { class: 'rv-block rm-reference-item', title: `Line ${line + 1}`, onclick }, h('span', { class: 'rv-bullet' }), t);
}

async function loadPreview(el: HTMLElement, path: string, act: SectionActions) {
  el.append('Loading…');
  try {
    el.replaceChildren(renderMarkdown(await act.read(path)));
    wireLinks(el, path, (to) => act.view(to), act.resolve);
  } catch (e) {
    el.replaceChildren(`Couldn't read this note: ${(e as Error).message}`);
  }
}

/** Make [[links]] in rendered note text open their target note (in the viewer). */
function wireLinks(el: HTMLElement, from: string, open: (to: string) => void, resolve: (t: string, f: string) => Promise<string | null>) {
  el.querySelectorAll<HTMLElement>('.rv-wl[data-target]').forEach((a) => {
    a.addEventListener('click', async (e) => {
      e.stopPropagation();
      const to = await resolve(a.dataset.target!, from);
      if (to) open(to); else { a.classList.add('rv-missing'); a.title = 'No such note in the vault'; }
    });
  });
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
    wireLinks(body, path, (to) => openViewer(to, undefined, act), act.resolve);
    body.querySelector('.rv-hl')?.scrollIntoView({ block: 'center' });
  } catch (e) {
    body.replaceChildren(`Couldn't read this note: ${(e as Error).message}`);
  }
}
