// The extension's page in Roam's Settings → Roam Depot: a list of connected vaults, each with
// its status and a Remove button, and an "Add vault folder" button. Folders can't be typed in
// as paths: Roam can only read a folder the user picks in the system folder dialog.
import { h } from './ui.ts';
import { OPEN_WITH_SETTING } from './open-with.ts';

export interface SettingsVault {
  id: string;
  name: string;
  /** e.g. "201 notes", "Indexing 50 of 201 notes", "Needs permission". */
  status: string;
  /** While the vault is scanned, how far the scan is: 0 to 1, or -1 with no total to count towards. */
  progress?: number;
  needsPermission: boolean;
  /** The last scan never finished, most likely because Roam ran out of memory: scan only on request. */
  unfinished: boolean;
  reconnect(): void;
  remove(): void;
}
export interface SettingsModel {
  vaults(): SettingsVault[];
  add(): void;
  rescan(): void;
  /** Call fn whenever the vault list or a status changes; returns an unsubscribe function. */
  subscribe(fn: () => void): () => void;
}

/** How far a scan is, by its status text ("120 of 500 notes"). */
export function scanProgress(text: string): number {
  const m = /^(\d+) of (\d+) notes/.exec(text);
  return m && +m[2] ? Math.min(1, +m[1] / +m[2]) : -1;
}

/** Roam's progress bar (Blueprint's, styled by Roam's own CSS). With no total it is the striped bar, full width. */
function progressBar(p: number) {
  const meter = h('div', { class: 'bp3-progress-meter' });
  meter.style.width = `${p < 0 ? 100 : Math.round(p * 100)}%`;
  return h('div', { class: `bp3-progress-bar bp3-intent-primary${p < 0 ? '' : ' bp3-no-stripes'}` }, meter);
}

export function renderSettings(el: HTMLElement, m: SettingsModel) {
  const vs = m.vaults();
  const btn = (label: string, fn: () => void, cls = '') =>
    h('button', { class: `bp3-button bp3-small ${cls}`, onclick: fn }, label);
  el.replaceChildren(
    h('div', { class: 'rv-settings' },
      vs.length
        ? h('div', { class: 'rv-settings-list' }, ...vs.map((v) => h('div', { class: 'rv-settings-row' },
            h('div', { class: 'rv-settings-name' }, v.name,
              v.progress === undefined ? null : progressBar(v.progress),
              h('div', { class: 'rv-settings-status' }, v.status)),
            // one group, so in a narrow column the buttons move below the name together
            h('div', { class: 'rv-settings-btns' },
              v.needsPermission ? btn('Reconnect', v.reconnect, 'bp3-intent-primary')
                : v.unfinished ? btn('Rescan', v.reconnect, 'bp3-intent-primary') : null,
              btn('Remove', v.remove, 'bp3-minimal')))))
        : null,
      h('div', { class: 'rv-settings-actions' }, btn('Add vault folder', m.add, 'bp3-intent-primary'),
        vs.length ? btn('Rescan', m.rescan, 'bp3-minimal') : null)));
}

/** Register the settings page. Uses Roam's reactComponent setting when Roam provides React,
 *  else falls back to a plain button. */
export function createSettingsPanel(extensionAPI: any, m: SettingsModel) {
  if (!extensionAPI?.settings?.panel?.create) return;
  const React = (window as any).React;
  const description = 'Obsidian-style vaults (folders of Markdown notes) shown as "External Vault References".';
  // Roam's own text setting: Roam saves it, and the viewer reads it each time it opens a note.
  const openWith = {
    id: OPEN_WITH_SETTING,
    name: 'Open notes with',
    description: 'Empty opens notes in Obsidian. For another editor, enter its link with {vault} and {file}, such as vscode://file/Users/you/Notes/{vault}/{file}',
    action: { type: 'input', placeholder: '' },
  };
  if (React?.createElement && React.useRef && React.useEffect) {
    const VaultList = () => {
      const ref = React.useRef(null);
      React.useEffect(() => {
        const el = ref.current as HTMLElement | null;
        if (!el) return;
        const draw = () => renderSettings(el, m);
        draw();
        return m.subscribe(draw);
      }, []);
      return React.createElement('div', { ref });
    };
    extensionAPI.settings.panel.create({
      tabTitle: 'Vaults',
      settings: [{ id: 'vaults', name: 'Vaults', description, action: { type: 'reactComponent', component: VaultList } }, openWith],
    });
  } else {
    extensionAPI.settings.panel.create({
      tabTitle: 'Vaults',
      settings: [{ id: 'add-vault', name: 'Add vault folder', description, action: { type: 'button', onClick: m.add, content: 'Add vault folder' } }, openWith],
    });
  }
}
