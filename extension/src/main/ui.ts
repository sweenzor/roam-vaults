// DOM pieces: styles, toasts, the "External Vault References" panel and the read-only note viewer.
// Plain DOM with Blueprint 3 class names (Roam ships Blueprint), so no bundled UI library.
import type { PageResult, Backlink } from '../engine.ts';
import { blockBody, inline } from './markdown.ts';
import { contextOf, kidsAt, lineOfSub, outlineOf, type OutlineBlock, type LineContext } from '../core/outline.ts';

export const ATTR = 'data-roam-vaults';

const STYLES = `
.rv-panel{padding-top:12px;margin:0 -4px 0 -16px}
.rv-counts{display:flex;flex-wrap:wrap;gap:4px 20px;margin:-20px 0 22px}
.rv-counts:empty{display:none}
.rv-counts strong{color:rgb(206,217,224);cursor:pointer}
.rv-panel:empty{display:none}
.rv-sec{margin-bottom:12px}
.rv-sec-head{display:flex;align-items:center;height:24px;gap:2px}
.rv-sec-head strong{color:rgb(206,217,224)}
.rv-sec-head .rv-head-caret{visibility:hidden}
.rv-sec-head:hover .rv-head-caret{visibility:visible;opacity:.7;cursor:pointer}
.rv-spacer{flex:1}
.rv-sec.rv-collapsed .rv-sec-body{display:none}
.rv-sec-body{margin-top:4px}
.rv-more{height:1px}
.rv-group-title{margin-right:8px}
.rv-fuzzy .rv-note{opacity:.55}
.rv-fuzzy .rv-group-caret{opacity:.55}
.rv-note .rm-highlight{margin:0;padding:0}
.rv-vault{color:#8a9ba8}
.rv-tagref{color:rgb(167,182,194);font-size:14px;margin-right:8px}
.rv-content{margin-left:4px}
.rv-code{margin:0;white-space:pre-wrap}
.rv-panel .rm-block-main:hover>.controls .rv-kids-caret{opacity:.7}
.rv-checkbox{pointer-events:none}
.rv-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:30000;max-width:560px;padding:10px 14px;border-radius:6px;background:#30404d;color:#fff;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.25)}
.rv-toast.rv-error{background:#a82a2a}
.rv-overlay{position:fixed;inset:0;z-index:20000;background:rgba(16,22,26,.45);display:flex;align-items:center;justify-content:center}
.rv-viewer{background:#fff;color:#182026;width:min(760px,92vw);max-height:86vh;display:flex;flex-direction:column;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.3)}
.rv-viewer-head{flex:none;display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #e5e5ea}
.rv-viewer-head h3{margin:0;font-size:18px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rv-note-open{white-space:nowrap;flex:none;align-self:center}
.rv-viewer-path{flex:none;padding:4px 16px 0;color:#8a8a99;font-size:12px}
.rv-viewer-body{min-height:0;padding:8px 20px 20px 4px;overflow:auto}
.rv-viewer-body.rv-preview{padding:4px 12px 6px 0;max-height:480px;overflow:auto}
.rv-missing,.rv-missing .rm-page-ref{color:#8a8a99;cursor:default}
.rv-settings{display:flex;flex-direction:column;gap:10px;width:280px;max-width:100%;min-width:0}
.rv-settings-list{display:flex;flex-direction:column;gap:6px}
.rv-settings-actions,.rv-settings-btns{display:flex;flex-wrap:wrap;gap:4px 8px}
.rv-settings-row{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}
.rv-settings-name{flex:1 1 100px;min-width:0;font-weight:500;overflow-wrap:anywhere}
.rv-settings .bp3-button{flex:0 1 auto;white-space:normal;text-align:left}
.rv-settings-status{font-weight:400;font-size:12px;color:#8a9ba8}
.rv-settings .bp3-progress-bar{margin:5px 0 3px}
.bp3-dark .rv-sec-head strong{color:#5c7080}
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
  | { kind: 'unfinished' } // the last scan never finished: it waits for Rescan
  | { kind: 'indexing'; detail: string }
  | { kind: 'error'; detail: string }
  | { kind: 'ready'; result: PageResult | null; live: boolean };

export interface SectionActions {
  reconnect(): void;
  remove(): void;
  /** Open a note: in Roam's main window, as a click on a page's title opens the page; `side` (a
   *  shift-click, which in Roam opens the sidebar) in the dialog over the page. */
  view(path: string, line?: number, side?: boolean): void;
  openOutside(path: string): void;
  openLabel(): string;
  read(path: string): Promise<string>;
  resolve(target: string, from: string): Promise<string | null>;
  /** An image file of the vault that a note shows, or null. */
  image(target: string, from: string): Promise<Blob | null>;
  /** Read the lines of linking notes that came without their text (`unread`), and put it in them. */
  lines(notes: Backlink[]): Promise<void>;
  /** A click on a link in a line: open the page it names in Roam, where Roam would for that click.
   *  False when the graph has no such page. */
  go(title: string, where: Where): boolean;
}
/** Where a click opens a page, as Roam has it for its own links: a plain click in the main window,
 *  shift-click in the sidebar, ctrl-shift-click its linked references there, alt-shift-click its graph. */
export type Where = 'main' | 'outline' | 'mentions' | 'graph';
export const whereOf = (e: MouseEvent): Where => (!e.shiftKey ? 'main' : e.ctrlKey || e.metaKey ? 'mentions' : e.altKey ? 'graph' : 'outline');
export interface PanelVault { id: string; name: string; state: SectionState; act: SectionActions }

const COLLAPSE_KEY = 'roam-vaults:collapsed';
const isCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } };
/** Note groups the user opened or closed, overriding the default. Kept across re-renders. */
const groupOpen = new Map<string, boolean>();

const caret = (open: boolean, extra = '') =>
  h('span', { class: `bp3-icon-standard bp3-icon-caret-down rm-caret ${open ? 'rm-caret-open' : 'rm-caret-closed'} ${extra}` });

/** Draws the panel and returns how many notes it lists. */
export function renderPanel(el: HTMLElement, vaults: PanelVault[]): number {
  el.className = 'rv-panel';
  drawing.get(el)?.disconnect(); drawing.delete(el);
  // With no vaults connected the page shows nothing; vaults are added in the extension's settings.
  if (!vaults.length) { el.replaceChildren(); return 0; }
  // Like Roam's own reference sections, nothing explains itself: no matches means no section,
  // and vaults that are indexing, unreadable or waiting for permission are shown only in settings.
  const ready: { v: PanelVault; r: PageResult }[] = [];
  let n = 0;
  for (const v of vaults) {
    const s = v.state;
    if (s.kind !== 'ready' || !s.result) continue;
    ready.push({ v, r: s.result });
    n += new Set([...s.result.counterparts, ...s.result.backlinks, ...s.result.tagged, ...(s.result.fuzzy ?? [])].map((x) => x.path)).size;
  }
  if (!n) { el.replaceChildren(); return 0; }
  const collapsed = isCollapsed();
  el.replaceChildren(h('div', { class: 'rv-sec' + (collapsed ? ' rv-collapsed' : '') },
    sectionHead(`${n} External Vault References`, !collapsed),
    h('div', { class: 'rv-sec-body' }, resultBody(el, ready, vaults.length > 1))));
  return n;
}

// ---------- counts under the page title ----------
// One line under the title with the page's reference counts, worded and styled like Roam's own
// section headers, so what is further down shows without scrolling. A click jumps to that section.
export interface Count { label: string; jump(): void }
export function renderCounts(el: HTMLElement, counts: Count[]) {
  const key = counts.map((c) => c.label).join('\n');
  if (el.dataset.key === key) return; // unchanged: leave the DOM alone, so this doesn't feed the page observer
  el.dataset.key = key;
  el.replaceChildren(...counts.map((c) => h('strong', { onclick: c.jump }, c.label)));
}

// A page named like a common tag can have thousands of notes to list, and drawing them all at once
// holds Roam up (4,000 notes: over half a second; 40,000: 20 seconds). So a panel draws its first
// notes and adds the rest as the end of the list comes near the window, as the page is scrolled.
const ROWS_AT_ONCE = 60;
const NEAR = '800px'; // how far below the window the end of the list may be before more is drawn
/** The observer watching the end of each panel's list, while there are notes left to draw. */
const drawing = new WeakMap<HTMLElement, IntersectionObserver>();
/** How many notes each panel has drawn, and for which page. */
const reached = new WeakMap<HTMLElement, { title: string; n: number }>();
/** How many notes a panel has drawn for the page it is on: drawn again, it draws as many. */
export function drawnRows(panel: HTMLElement): number {
  const r = reached.get(panel);
  return r && r.title === (panel.dataset.title ?? '') ? r.n : 0;
}

function sectionHead(label: string, open = true, tools: HTMLElement[] = []) {
  const head = h('div', { class: 'rv-sec-head' },
    caret(open, 'rv-head-caret'),
    h('strong', {}, label),
    h('span', { class: 'rv-spacer' }),
    ...tools);
  // As in Roam, only the caret folds the section; the words do nothing.
  head.querySelector('.rv-head-caret')!.addEventListener('click', () => {
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
function resultBody(panel: HTMLElement, list: { v: PanelVault; r: PageResult }[], showVault: boolean): HTMLElement {
  const out = h('div', { class: 'rv-groups rm-mentions refs-by-page-view' }); // Roam's own list classes: its style sheet lays the groups out
  /** One note: caret + (vault/)path as a namespaced title (+ tag); content shows when open. The open-in-editor button lives in the viewer. */
  const group = (v: PanelVault, key: string, path: string, defOpen: boolean, tag: string | undefined, content: () => HTMLElement, cls = '', marks: number[] = []) => {
    const k = `${v.id}\n${key}\n${path}`;
    const box = h('div', { class: 'rv-content' });
    const c = caret(false, 'rm-caret-showing rv-group-caret dont-focus-block');
    const set = (open: boolean) => {
      c.classList.toggle('rm-caret-open', open); c.classList.toggle('rm-caret-closed', !open);
      box.hidden = !open;
      if (open && !box.childNodes.length) box.append(content());
    };
    c.addEventListener('click', () => {
      const open = box.hidden;
      groupOpen.delete(k); groupOpen.set(k, open);
      if (groupOpen.size > 500) groupOpen.delete(groupOpen.keys().next().value!);
      set(open);
    });
    set(groupOpen.get(k) ?? defOpen);
    // The folders a note is in, in the grey a vault's name has, so the title reads as the note's name.
    const name = path.lastIndexOf('/') + 1;
    return h('div', { class: 'rm-ref-page-view rv-group' + cls },
      h('div', { class: 'flex-h-box rm-title-arrow-wrapper rv-group-head' }, c,
        h('div', { class: 'rm-ref-page-view-title rv-group-title' },
          h('a', { onclick: (e: MouseEvent) => v.act.view(path, undefined, e.shiftKey) },
            h('span', { class: 'rm-page__title rv-note', style: 'cursor: pointer; text-decoration: none;' },
              showVault || name ? h('span', { class: 'rv-vault' }, (showVault ? `${v.name}/` : '') + path.slice(0, name)) : null,
              ...marked(path.slice(name).replace(/\.md$/i, ''), 0, marks)))),
        tag ? h('span', { class: 'rv-tagref' }, `#${tag}`) : null),
      box);
  };
  // rm-reference-item: Roam's own grey reference background.
  const preview = (v: PanelVault, path: string) => () => { const el = h('div', { class: 'rv-viewer-body rv-preview rm-reference-item' }); loadPreview(el, path, v.act); return el; };

  // The list is worked out whole, as one small function per note, and drawn a part at a time.
  // A note shows once: a tagged note that also links here gets the tag next to its title.
  const rows: (() => HTMLElement)[] = [];
  /** The linking note a row is, where its lines are still to be read, by row. */
  const unread = new Map<number, { v: PanelVault; b: Backlink }>();
  const tagsOf = new Map(list.map(({ v, r }) => [v, new Map(r.tagged.map((t) => [t.path, t.tag]))]));
  const tagOnce = (v: PanelVault, path: string) => {
    const tags = tagsOf.get(v)!, t = tags.get(path); tags.delete(path);
    return t;
  };
  for (const { v, r } of list) for (const c of r.counterparts) {
    const tag = tagOnce(v, c.path);
    rows.push(() => group(v, 'page', c.path, false, tag, preview(v, c.path)));
  }
  for (const { v, r } of list) for (const b of r.backlinks) {
    const tag = tagOnce(v, b.path);
    if (b.unread) unread.set(rows.length, { v, b });
    rows.push(() => group(v, 'links', b.path, true, tag, () => {
      const box = h('div', {});
      // Two links in one block are one reference, as in Roam.
      const draw = () => box.replaceChildren(...b.lines.filter((l, i) => !b.lines.slice(0, i).some((x) => (x.at ?? x.line) === (l.at ?? l.line)))
        .map((l) => referenceEl({ text: l.text, line: l.at ?? l.line, up: l.up ?? [], kids: l.kids ?? [], cut: l.cut }, b.path, v.act)));
      draw();
      // Its lines are read before it is drawn (see `ahead`); if that failed, they are filled in here.
      if (b.unread) v.act.lines([b]).then(draw, () => {});
      return box;
    }));
  }
  for (const { v, r } of list) for (const t of r.tagged) {
    const tag = tagOnce(v, t.path);
    if (tag !== undefined) rows.push(() => group(v, 'tag', t.path, false, tag, preview(v, t.path)));
  }
  // Notes with a name close to the title: last, faded, the letters that differ highlighted.
  for (const { v, r } of list) for (const f of r.fuzzy ?? [])
    rows.push(() => group(v, 'fuzzy', f.path, false, undefined, preview(v, f.path), ' rv-fuzzy', f.marks));

  // Drawn again for the same page (a note changed, a vault finished scanning), the list is as long
  // as it had got, so the page doesn't jump under a reader who had scrolled down it.
  const title = panel.dataset.title ?? '', before = reached.get(panel);
  let drawn = 0;
  const more = (n: number) => {
    const part = rows.slice(drawn, drawn + n).map((row) => row());
    drawn += part.length;
    reached.set(panel, { title, n: drawn });
    return part;
  };
  /** Read the lines of the next `n` notes, a vault at a time, so they are drawn with their text. */
  const ahead = async (n: number) => {
    const by = new Map<PanelVault, Backlink[]>();
    for (let i = drawn; i < drawn + n; i++) {
      const u = unread.get(i);
      if (u?.b.unread) by.set(u.v, [...(by.get(u.v) ?? []), u.b]);
    }
    await Promise.all([...by].map(([v, notes]) => v.act.lines(notes).catch(() => {})));
  };
  out.append(...more(Math.max(ROWS_AT_ONCE, before?.title === title ? before.n : 0)));
  if (drawn < rows.length && typeof IntersectionObserver !== 'undefined') {
    const end = h('div', { class: 'rv-more' });
    out.append(end);
    let reading = false;
    // scrollMargin: Roam's page scrolls inside the window, and rootMargin alone stops at that box
    const io = new IntersectionObserver(async (entries) => {
      if (!end.isConnected) { io.disconnect(); return; } // the panel was drawn again or removed
      if (reading || !entries.some((e) => e.isIntersecting)) return;
      reading = true;
      try { await ahead(ROWS_AT_ONCE); } finally { reading = false; }
      if (!end.isConnected) { io.disconnect(); return; }
      end.before(...more(ROWS_AT_ONCE));
      io.unobserve(end);
      if (drawn < rows.length) io.observe(end); // looked at afresh: it may still be near the window
      else { end.remove(); io.disconnect(); drawing.delete(panel); }
    }, { rootMargin: `0px 0px ${NEAR} 0px`, scrollMargin: `0px 0px ${NEAR} 0px` } as IntersectionObserverInit);
    io.observe(end);
    drawing.set(panel, io);
  } else if (drawn < rows.length) out.append(...more(rows.length));
  return out;
}

/** Text with some ranges (flat [start, end) pairs, counted from `from`) in Roam's ^^highlight^^. */
function marked(text: string, from: number, marks: number[]): (string | HTMLElement)[] {
  const out: (string | HTMLElement)[] = [];
  let at = 0;
  for (let i = 0; i < marks.length; i += 2) {
    const a = from + marks[i], b = from + marks[i + 1];
    if (a > at) out.push(text.slice(at, a));
    out.push(h('span', { class: 'rm-highlight' }, text.slice(a, b)));
    at = b;
  }
  out.push(text.slice(at));
  return out;
}

// A reference is drawn with the elements and class names of Roam's own Linked References (measured
// in Roam, 2026-11-22): the grey box, the path of parent blocks, the block with its bullet, and its
// children under it. Roam's style sheet does the rest, and so does a theme.

/** One reference: a block of a note with the blocks above it as a path. A click on a part of the
 *  path shows that block in its place, with everything under it, as in Roam. */
function referenceEl(block: LineContext, path: string, act: SectionActions): HTMLElement {
  const inner = h('div', {});
  const ctx = ctxOf(path, act);
  /** `shown`: the block to draw, under the parents still shown as a path. */
  const show = (up: LineContext['up'], shown: OutlineBlock, mark?: number) => {
    const zoom = h('div', { class: 'rm-zoom zoom-mentions-view' }, ...up.map((u, i) => {
      const text = h('span', {});
      blockBody(text, u.text.split('\n')[0]);
      // The whole part is one target, links in it too: it shows that parent in place.
      return h('div', { class: 'rm-zoom-item', onclick: () => expand(i) },
        h('span', { class: 'rm-zoom-item-content' }, h('div', { class: 'parent-path-wrapper' }, text)),
        i < up.length - 1 ? h('span', { class: 'bp3-icon-standard bp3-icon-chevron-right rm-mention-icon' }) : null);
    }));
    inner.replaceChildren(zoom, blockEl(shown, 1, { ...ctx, mark }));
  };
  /** A click on part `i` of the path: that parent and those under it are drawn as blocks, the
   *  reference among them and marked. The nearest parent shows all its children, the ones above it
   *  only the one on the way down, as Roam does. */
  const expand = async (i: number) => {
    let text: string;
    try { text = await act.read(path); } catch { return; } // the note is gone: the panel is drawn again when the vault notices
    const whole = outlineOf(text);
    const find = (blocks: OutlineBlock[], line: number): OutlineBlock | null => {
      for (const b of blocks) { if (b.line === line) return b; const k = find(b.kids, line); if (k) return k; }
      return null;
    };
    const last = block.up.length - 1;
    let shown: OutlineBlock = find(whole, block.up[last].line) ?? { text: block.up[last].text, line: block.up[last].line, kids: [block] };
    for (let k = last - 1; k >= i; k--) shown = { text: block.up[k].text, line: block.up[k].line, kids: [shown] };
    show(block.up.slice(0, i), shown, block.line);
  };
  show(block.up, block);
  return h('div', { class: 'flex-h-box flex-align-start' }, h('div', { class: 'rm-reference-item dont-focus-block' }, inner));
}

/** What a drawn block needs of the note it is from. */
/** What drawing a note's blocks asks of its vault. */
type NoteActs = Pick<SectionActions, 'go' | 'resolve' | 'read' | 'image' | 'view'>;
/** An embed in an embed in an embed is drawn; one more level down stays a link. */
const MAX_EMBEDS = 3;
/** The context for the blocks of the note at `path`. `depth`: how many embeds it is inside. */
function ctxOf(path: string, act: NoteActs, depth = 0, noteFirst = false): BlockCtx {
  return {
    read: () => act.read(path),
    open: (line, side) => act.view(path, line, side),
    link: (e) => linkClick(e, path, act, noteFirst),
    refs: (el) => fill(el, path, act, depth),
  };
}

/** Put in what a block's text names and needs the vault for: the text of a block reference
 *  ([[Note#^id]]), an image of the vault, and an embedded note, heading or block. */
function fill(el: HTMLElement, from: string, act: NoteActs, depth: number) {
  el.querySelectorAll<HTMLElement>('[data-rv-fill]').forEach(async (ref) => {
    delete ref.dataset.rvFill;
    try {
      const target = ref.dataset.rvTarget!;
      const to = target ? await act.resolve(target, from) : from;
      if (!to) return;
      const text = await act.read(to);
      const line = lineOfSub(text, ref.dataset.rvSub!);
      if (line === undefined) return;
      const span = document.createElement('span');
      inline(span, contextOf(text, [line])[0].text.split('\n')[0]);
      span.querySelectorAll('[data-rv-fill]').forEach((r) => delete (r as HTMLElement).dataset.rvFill); // a reference in a reference stays as written
      ref.replaceChildren(span);
    } catch { /* stays as written */ }
  });
  el.querySelectorAll<HTMLImageElement>('img[data-rv-img]').forEach(async (img) => {
    const blob = await act.image(img.dataset.rvImg!, from).catch(() => null);
    if (!blob) return; // a broken image, as in Roam: its alt text
    const url = URL.createObjectURL(blob);
    img.onload = img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  });
  if (depth < MAX_EMBEDS) el.querySelectorAll<HTMLElement>('[data-rv-embed]').forEach((ph) => { embed(ph, from, act, depth).catch(() => { /* stays the link */ }); });
}

/** Draw what an embed names in its place, with Roam's elements for {{embed}} (measured in Roam,
 *  2026-11-23). A note is its title, closed, and the bar at its left opens it, as a page embed is in
 *  Roam. A heading or a block is that block with what is under it. */
async function embed(ph: HTMLElement, from: string, act: NoteActs, depth: number) {
  const target = ph.dataset.rvEmbed!, sub = ph.dataset.rvEmbedSub;
  delete ph.dataset.rvEmbed;
  const to = target ? await act.resolve(target, from) : from;
  if (!to) return;
  const ctx = ctxOf(to, act, depth + 1);
  /** In Roam a block that holds an embed is not a `rm-block-text`: the embed's own blocks are. */
  const put = (box: HTMLElement) => { const input = ph.closest('.rm-block__input'); ph.replaceWith(box); input?.classList.remove('rm-block-text'); };
  if (!sub) {
    const content = h('div', { class: 'rm-embed__content' });
    let open = false;
    const bar = h('div', { class: 'rm-embed-margin-action rm-closed', onclick: async (e: Event) => {
      e.stopPropagation();
      open = !open;
      bar.classList.toggle('rm-open', open); bar.classList.toggle('rm-closed', !open);
      if (!open) { content.remove(); return; }
      try { content.replaceChildren(h('div', { class: 'rm-block-children rm-block__children rm-level-0' }, h('div', { class: 'rm-multibar' }), noteEl(await act.read(to), ctx))); } catch { return; }
      if (open) box.append(content);
    } });
    const box = h('div', { class: 'rm-embed rm-embed--page rm-embed-container dont-focus-block nodrag' }, bar,
      h('h3', { class: 'rm-page__title' }, h('a', {},
        h('span', { class: 'rm-page__title', tabindex: '-1', style: 'cursor: pointer; text-decoration: none;', onclick: (e: MouseEvent) => { e.stopPropagation(); act.view(to, undefined, e.shiftKey); } }, to.slice(to.lastIndexOf('/') + 1).replace(/\.md$/i, '')))));
    put(box);
    return;
  }
  const text = await act.read(to);
  const line = lineOfSub(text, sub);
  if (line === undefined) return;
  const at = contextOf(text, [line])[0].line; // the block that line is in
  const find = (blocks: OutlineBlock[]): OutlineBlock | null => { for (const b of blocks) { if (b.line === at) return b; const k = find(b.kids); if (k) return k; } return null; };
  const block = find(outlineOf(text)); // from the outline: a heading keeps its size there
  if (!block) return;
  put(h('div', { class: 'rm-embed-container rm-embed-container--block nodrag rm-hide-bullet', onclick: (e: Event) => e.stopPropagation() },
    h('div', { class: 'rm-hide-bullet', style: 'flex: 1 1 100%; overflow: clip visible;' },
      h('div', { class: 'rm-embed-inner-block-hide dont-focus-block' },
        h('div', { class: 'rm-embed-margin-action rm-not' }),
        blockEl(block, 0, { ...ctx, unfolded: true })))));
}

interface BlockCtx {
  /** The note's text, for children that did not come with the block. */
  read(): Promise<string>;
  /** A click on the block's bullet, which in Roam opens the block: open the note at that line. Left out where the note is already open. */
  open?(line: number, side?: boolean): void;
  /** A click in the block's text: follow the link it landed on, if any. */
  link(e: MouseEvent): boolean;
  /** Fill the block references in a block's text in. */
  refs(el: HTMLElement): void;
  /** Blocks with children show them from the start (a note shown whole), not when asked. */
  unfolded?: boolean;
  /** The line to mark: its block is highlighted, and the blocks above it show their children. */
  mark?: number;
}

/** A block as Roam draws one: caret (when it has children), bullet, text, and its children nested
 *  under it. */
function blockEl(b: OutlineBlock, level: number, ctx: BlockCtx): HTMLElement {
  const text = h('span', {});
  const heading = blockBody(text, b.text);
  ctx.refs(text);
  const has = b.kids.length > 0 || !!b.cut;
  // In Roam's Linked References a reference's children show when asked for; a note shown whole is open.
  let open = has && !b.cut && (!!ctx.unfolded || (ctx.mark !== undefined && holds(b, ctx.mark)));
  const kidsBox = h('div', { class: `rm-block-children rm-block__children rm-level-${level + 1}` });
  const c = h('span', { class: `bp3-icon-standard bp3-icon-caret-down rm-caret rm-caret-hidden${has ? ' rv-kids-caret' : ''}` });
  // an item of a numbered list has its number for a bullet, as the children of a block viewed as numbered have in Roam
  const bullet = h('span', { class: b.n === undefined ? 'rm-bullet' : `rm-bullet rm-bullet--numbered rm-bullet--numbered-${b.n < 10 ? 'single' : 'double'}-digit`, onclick: (e: MouseEvent) => ctx.open?.(b.line, e.shiftKey) },
    h('span', { class: 'bp3-popover-wrapper' }, h('span', { class: 'bp3-popover-target' }, // Roam's wrappers: they set the line the dot sits on
      b.n === undefined ? h('span', { class: 'rm-bullet__inner' }) : h('span', { class: 'rm-bullet__inner--numbered' }, `${b.n}.`))));
  const box = h('div', { class: 'roam-block-container rm-block rm-not-focused block-bullet-view' + (heading ? ` rm-heading-level-${Math.min(heading, 3)}` : '')
    + (b.line === ctx.mark ? ' block-highlight-yellow rv-hl' : '') }, // Roam's own mark for the block a path was opened from
    h('div', { class: 'rm-block-main rm-block__self' },
      h('div', { class: 'controls rm-block__controls noselect' }, h('span', { class: 'block-expand' }, c), bullet),
      // A click on the text follows a link under it and nothing else: in Roam it would edit the block.
      h('div', { class: 'rm-block__input rm-block__input--view roam-block dont-unfocus-block hoverparent' + (text.querySelector('.rm-table') ? '' : ' rm-block-text'), onclick: (e: MouseEvent) => { ctx.link(e); } }, text),
      h('div', { class: 'rm-block-separator' }),
      h('div', { style: 'min-width: 24px;' })),
    kidsBox);
  let kids = b.kids, whole = !b.cut;
  const set = async () => {
    box.classList.toggle('rm-block--open', open || !has); box.classList.toggle('rm-block--closed', has && !open);
    c.classList.toggle('rm-caret-open', open); c.classList.toggle('rm-caret-closed', !open);
    bullet.classList.toggle('rm-bullet--closed', has && !open);
    if (!open) { kidsBox.replaceChildren(bar()); return; }
    if (!whole) { try { kids = kidsAt(await ctx.read(), b.line); whole = true; } catch { /* drawn with what came */ } }
    kidsBox.replaceChildren(bar(), ...kids.map((k) => blockEl(k, level + 1, ctx)));
  };
  const toggle = (e: Event) => { e.stopPropagation(); if (has) { open = !open; set(); } };
  const bar = () => h('div', { class: 'rm-multibar', onclick: toggle });
  c.addEventListener('click', toggle);
  set();
  return box;
}
/** Is a line in a block or under it? */
const holds = (b: OutlineBlock, line: number): boolean => b.line === line || b.kids.some((k) => holds(k, line));
/** Blocks in an outline. */
const count = (blocks: OutlineBlock[]): number => blocks.reduce((n, b) => n + 1 + count(b.kids), 0);
/** A note drawn whole comes unfolded up to this many blocks; a longer one unfolds as it is read. */
const UNFOLDED_BLOCKS = 400;

/** A whole note as a Roam outline: its properties, headings, lists and paragraphs as blocks. */
function noteEl(text: string, ctx: BlockCtx, mark?: number): DocumentFragment {
  const blocks = outlineOf(text);
  const at = mark === undefined ? undefined : contextOf(text, [mark])[0].line;
  const frag = document.createDocumentFragment();
  const all = { ...ctx, mark: at, unfolded: count(blocks) <= UNFOLDED_BLOCKS };
  frag.append(...blocks.map((b) => blockEl(b, 1, all)));
  return frag;
}

/** A click that landed on a link in a note's text. In the page's section the page it names opens in
 *  Roam, where Roam would open it for that click; when the graph has no such page, the note it names
 *  opens in the viewer. In the viewer (`noteFirst`) it is the note first, then the page. Returns
 *  whether the click was on a link. */
function linkClick(e: MouseEvent, from: string, act: NoteActs, noteFirst = false): boolean {
  const t = e.target as Element;
  if (t.closest?.('a[href]')) { e.stopPropagation(); return true; } // a web link: the browser opens it
  const a = t.closest?.<HTMLElement>('[data-rv-target]');
  if (!a) return false;
  e.stopPropagation(); e.preventDefault();
  const target = a.dataset.rvTarget!, where = whereOf(e);
  const name = target.slice(target.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const page = () => act.go(target, where) || (name !== target && act.go(name, where));
  const sub = a.dataset.rvSub;
  const note = async () => {
    try {
      const to = target ? await act.resolve(target, from) : from;
      if (!to) return false;
      act.view(to, sub ? lineOfSub(await act.read(to), sub) : undefined, where !== 'main');
      return true;
    } catch { return false; }
  };
  // a heading or a block of a note: Roam's pages have neither, so it is the note that opens, there
  if (sub || !target) note().then((found) => { if (!found && !(target && page())) a.classList.add('rv-missing'); });
  else if (noteFirst) note().then((found) => { if (!found && !page()) a.classList.add('rv-missing'); });
  else if (!page()) note();
  return true;
}

async function loadPreview(el: HTMLElement, path: string, act: SectionActions) {
  try {
    el.replaceChildren(noteEl(await act.read(path), ctxOf(path, act)));
  } catch (e) {
    el.replaceChildren(`Couldn't read this note: ${(e as Error).message}`);
  }
}

// ---------- viewer ----------
export interface ViewerActions {
  read(path: string): Promise<string>;
  resolve(target: string, from: string): Promise<string | null>;
  image(target: string, from: string): Promise<Blob | null>;
  /** Open the note in Obsidian or the editor set in "Open notes with". */
  openOutside(path: string): void;
  openLabel(): string;
  /** Open the Roam page a link names, when no note has that name. */
  go(title: string, where: Where): boolean;
}
let overlay: HTMLElement | null = null;
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeViewer(); } };
export function closeViewer() { overlay?.remove(); overlay = null; document.removeEventListener('keydown', onKey, true); }

export async function openViewer(path: string, line: number | undefined, act: ViewerActions) {
  closeViewer();
  const title = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const body = h('div', { class: 'rv-viewer-body' });
  overlay = h('div', { class: 'rv-overlay', [ATTR]: 'viewer', onclick: (e: Event) => { if (e.target === overlay) closeViewer(); } },
    h('div', { class: 'rv-viewer', role: 'dialog', 'aria-label': title },
      h('div', { class: 'rv-viewer-head' },
        h('h3', {}, title),
        h('button', { class: 'bp3-button bp3-small', onclick: () => act.openOutside(path) }, act.openLabel()),
        h('button', { class: 'bp3-button bp3-small bp3-minimal', 'aria-label': 'Close', onclick: closeViewer }, '✕')),
      h('div', { class: 'rv-viewer-path' }, path),
      body));
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  try {
    const text = await act.read(path);
    const links: NoteActs = { resolve: act.resolve, read: act.read, image: act.image, view: (to: string, at?: number) => { openViewer(to, at, act); }, // a note opened from the dialog opens in it
      go: (title: string, where: Where) => { const ok = act.go(title, where); if (ok && where === 'main') closeViewer(); return ok; } };
    body.replaceChildren(noteEl(text, { ...ctxOf(path, links, 0, true), open: undefined }, line));
  } catch (e) {
    body.replaceChildren(`Couldn't read this note: ${(e as Error).message}`);
  }
}

// ---------- a note in the main window ----------
/** A note as a page in Roam's main window: its name as the page title, its blocks under it, with
 *  the elements Roam's own page has (measured in Roam, 2026-11-23). `view` opens another note. */
export async function drawNote(host: HTMLElement, path: string, line: number | undefined, act: ViewerActions, view: SectionActions['view']) {
  const title = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const blocks = h('div', { class: 'rm-block-children rm-block__children rm-level-0' });
  host.replaceChildren(h('div', { class: 'rm-article-wrapper rm-spacing--small rv-note-page', [ATTR]: 'note' },
    h('div', { class: 'roam-article' }, h('div', {},
      h('div', { class: 'rm-title-display-container' },
        h('h1', { class: 'rm-title-display' }, h('span', {}, title)),
        h('button', { class: 'bp3-button bp3-small bp3-minimal rv-note-open', onclick: () => act.openOutside(path) }, act.openLabel())),
      blocks))));
  try {
    const text = await act.read(path);
    blocks.replaceChildren(noteEl(text, ctxOf(path, { resolve: act.resolve, read: act.read, image: act.image, go: act.go, view }, 0, true), line));
    blocks.querySelector('.rv-hl')?.scrollIntoView({ block: 'center' });
  } catch (e) {
    blocks.replaceChildren(`Couldn't read this note: ${(e as Error).message}`);
  }
}
