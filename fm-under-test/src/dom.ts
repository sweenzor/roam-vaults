// Tiny DOM helper. Plain DOM with Roam's own class names (Roam ships Blueprint 3 and styles its
// All Pages table with rm-pages-*), so the extension bundles no UI library and looks like Roam.
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c != null && c !== false) el.append(c);
  return el;
}
export const icon = (name: string, cls = '') => h('span', { class: `bp3-icon bp3-icon-${name} ${cls}`.trim() });
