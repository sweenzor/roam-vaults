// Roam can show or hide the [[ ]] around page links (Settings > Preferences > Brackets, or Ctrl-C
// Ctrl-B). Links in vault lines follow it. Roam has no call that says which it is, and hiding leaves
// the bracket elements out of the page with no class set anywhere (measured, 2026-11-22). So one
// hidden link is drawn by Roam itself and watched: it is drawn again when the setting changes.
import { ATTR } from './ui.ts';

/** Starts following Roam's bracket setting. Returns what stops it. */
export function followBrackets(): () => void {
  const render = window.roamAlphaAPI?.ui?.components;
  if (typeof render?.renderString !== 'function') return () => {}; // brackets stay, as Roam starts with
  // The rule that hides the brackets of vault lines; `media` turns it on and off.
  const hide = document.createElement('style');
  hide.setAttribute(ATTR, 'brackets');
  hide.textContent = '.rv-panel .rm-page-ref__brackets,.rv-viewer .rm-page-ref__brackets,.rv-note-page .rm-page-ref__brackets{display:none}';
  hide.media = 'not all';
  const probe = document.createElement('div');
  probe.setAttribute(ATTR, 'probe');
  probe.hidden = true;
  document.head.append(hide);
  document.body.append(probe);
  const look = () => { if (probe.querySelector('.rm-page-ref')) hide.media = probe.querySelector('.rm-page-ref__brackets') ? 'not all' : 'all'; };
  const mo = new MutationObserver(look);
  mo.observe(probe, { childList: true, subtree: true });
  try { Promise.resolve(render.renderString({ el: probe, string: '[[x]]' })).then(look, () => {}); } catch { /* brackets stay */ }
  return () => {
    mo.disconnect();
    try { render.unmountNode?.({ el: probe }); } catch { /* removed below either way */ }
    probe.remove(); hide.remove();
  };
}
