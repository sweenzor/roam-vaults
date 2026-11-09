// Folder picker with a guard for a Roam desktop quirk found in the in-app spike:
// choosing a folder macOS protects (Documents, Desktop or the home folder itself)
// shows no error, and showDirectoryPicker() never settles. Every later call then
// fails with "File picker already active" until Roam restarts.
import { notify } from './ui.ts';

const STUCK_MSG =
  "Roam couldn't open that folder. macOS protects folders like Documents, Desktop and your home folder, " +
  'and Roam gives no error when you pick one. Quit Roam (Cmd+Q), reopen it, and choose the vault folder ' +
  'inside instead, for example Documents/My Vault.';

let pending: Promise<FileSystemDirectoryHandle | null> | null = null;
let stuck = false;

export async function pickVaultFolder(): Promise<FileSystemDirectoryHandle | null> {
  const w = window as any;
  if (!w.showDirectoryPicker) { notify("This version of Roam can't open local folders.", 'error'); return null; }
  if (stuck || pending) { notify(STUCK_MSG, 'error', 15000); return null; }

  let settled = false;
  const started = Date.now();
  // The picker is modal: the next click or key press in Roam means it has closed.
  // If the promise is still pending by then, it is the silent hang.
  const watchdog = () => {
    if (settled || Date.now() - started < 400) return;
    setTimeout(() => { if (!settled) { stuck = true; notify(STUCK_MSG, 'error', 15000); } }, 1000);
    stopWatch();
  };
  const stopWatch = () => {
    document.removeEventListener('pointerdown', watchdog, true);
    document.removeEventListener('keydown', watchdog, true);
    window.removeEventListener('focus', watchdog);
  };
  document.addEventListener('pointerdown', watchdog, true);
  document.addEventListener('keydown', watchdog, true);
  window.addEventListener('focus', watchdog);

  pending = (async () => {
    try {
      return (await w.showDirectoryPicker({ id: 'roam-vaults', mode: 'read' })) as FileSystemDirectoryHandle;
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') return null; // the user cancelled
      if (/already active/i.test(err.message)) { stuck = true; notify(STUCK_MSG, 'error', 15000); return null; }
      notify(`Couldn't open the folder: ${err.message}`, 'error');
      return null;
    } finally {
      settled = true; stuck = false; pending = null; stopWatch();
    }
  })();
  return pending;
}

/** Ask for read access again after a restart, if Roam didn't keep it. Needs a click. */
export async function ensurePermission(h: FileSystemDirectoryHandle, ask: boolean): Promise<boolean> {
  const hh = h as any;
  if ((await hh.queryPermission({ mode: 'read' })) === 'granted') return true;
  if (!ask) return false;
  return (await hh.requestPermission({ mode: 'read' })) === 'granted';
}
