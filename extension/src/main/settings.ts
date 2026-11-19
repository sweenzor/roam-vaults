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
  needsPermission: boolean;
  /** The last scan never finished, most likely because Roam ran out of memory: scan only on request. */
  unfinished: boolean;
  reconnect(): void;
  remove(): void;
}
/** Roam setting holding whether the counts line shows under page titles. Off unless turned on. */
export const COUNTS_SETTING = 'reference-counts';

export interface SettingsModel {
  vaults(): SettingsVault[];
  /** The "Reference counts" switch was flipped. */
  countsChanged(on: boolean): void;
  add(): void;
  rescan(): void;
  /** Call fn whenever the vault list or a status changes; returns an unsubscribe function. */
  subscribe(fn: () => void): () => void;
}

export function renderSettings(el: HTMLElement, m: SettingsModel) {
  const vs = m.vaults();
  const btn = (label: string, fn: () => void, cls = '') =>
    h('button', { class: `bp3-button bp3-small ${cls}`, onclick: fn }, label);
  el.replaceChildren(
    h('div', { class: 'rv-settings' },
      vs.length
        ? h('div', { class: 'rv-settings-list' }, ...vs.map((v) => h('div', { class: 'rv-settings-row' },
            h('div', { class: 'rv-settings-name' }, v.name, h('div', { class: 'rv-settings-status' }, v.status)),
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
  // Roam's own switch setting: Roam saves it; off until it is turned on.
  const counts = {
    id: COUNTS_SETTING,
    name: 'Reference counts',
    description: 'Show how many Linked, Unlinked and External Vault References a page has, under its title. Click a count to jump to that section.',
    action: { type: 'switch', onChange: (e: any) => m.countsChanged(typeof e?.target?.checked === 'boolean' ? e.target.checked : !!e) },
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
      settings: [{ id: 'vaults', name: 'Vaults', description, action: { type: 'reactComponent', component: VaultList } }, counts, openWith],
    });
  } else {
    extensionAPI.settings.panel.create({
      tabTitle: 'Vaults',
      settings: [{ id: 'add-vault', name: 'Add vault folder', description, action: { type: 'button', onClick: m.add, content: 'Add vault folder' } }, counts, openWith],
    });
  }
}
