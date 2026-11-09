// The extension's page in Roam's Settings → Roam Depot: a list of connected vaults, each with
// its status and a Remove button, and an "Add vault folder" button. Folders can't be typed in
// as paths: Roam can only read a folder the user picks in the system folder dialog.
import { h } from './ui.ts';

export interface SettingsVault {
  id: string;
  name: string;
  /** e.g. "201 notes", "Indexing 50 of 201 notes", "Needs permission". */
  status: string;
  needsPermission: boolean;
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

export function renderSettings(el: HTMLElement, m: SettingsModel) {
  const vs = m.vaults();
  const btn = (label: string, fn: () => void, cls = '') =>
    h('button', { class: `bp3-button bp3-small ${cls}`, onclick: fn }, label);
  el.replaceChildren(
    h('div', { class: 'rv-settings' },
      vs.length
        ? h('div', { class: 'rv-settings-list' }, ...vs.map((v) => h('div', { class: 'rv-settings-row' },
            h('div', { class: 'rv-settings-name' }, v.name, h('div', { class: 'rv-settings-status' }, v.status)),
            v.needsPermission ? btn('Reconnect', v.reconnect, 'bp3-intent-primary') : null,
            btn('Remove', v.remove, 'bp3-minimal'))))
        : h('div', { class: 'rv-settings-status' }, 'No vaults yet.'),
      h('div', { class: 'rv-settings-actions' }, btn('Add vault folder', m.add, 'bp3-intent-primary'),
        vs.length ? btn('Rescan', m.rescan, 'bp3-minimal') : null),
      h('div', { class: 'rv-settings-status' },
        'Pick the vault folder itself, for example Documents/My Vault, not Documents. ' +
        'Removing a vault forgets it on this device and deletes its cache; the folder is untouched.')));
}

/** Register the settings page. Uses Roam's reactComponent setting when Roam provides React,
 *  else falls back to a plain button. */
export function createSettingsPanel(extensionAPI: any, m: SettingsModel) {
  if (!extensionAPI?.settings?.panel?.create) return;
  const React = (window as any).React;
  const description = 'Obsidian-style vaults (folders of Markdown notes) shown in External Vault References.';
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
      tabTitle: 'External Vault References',
      settings: [{ id: 'vaults', name: 'Vaults', description, action: { type: 'reactComponent', component: VaultList } }],
    });
  } else {
    extensionAPI.settings.panel.create({
      tabTitle: 'External Vault References',
      settings: [{ id: 'add-vault', name: 'Add vault folder', description, action: { type: 'button', onClick: m.add, content: 'Add vault folder' } }],
    });
  }
}
