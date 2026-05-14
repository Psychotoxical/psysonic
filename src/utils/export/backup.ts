import { save, open as openDialog } from '@tauri-apps/plugin-dialog';
import { writeFile, readTextFile } from '@tauri-apps/plugin-fs';
import { version as appVersion } from '../../../package.json';

const BACKUP_VERSION = 1;

const BACKUP_KEYS = [
  'psysonic-auth',
  'psysonic_theme',
  'psysonic_font',
  'psysonic_language',
  'psysonic_keybindings',
  'psysonic_sidebar',
  'psysonic-eq',
  'psysonic_global_shortcuts',
  'psysonic-player',
  'psysonic_home',
];

export async function exportBackup(): Promise<string | null> {
  const stores: Record<string, unknown> = {};
  for (const key of BACKUP_KEYS) {
    const val = localStorage.getItem(key);
    if (val !== null) {
      try {
        stores[key] = JSON.parse(val);
      } catch {
        stores[key] = val;
      }
    }
  }

  const manifest = {
    version: BACKUP_VERSION,
    app_version: appVersion,
    created_at: new Date().toISOString(),
    stores,
  };

  const today = new Date().toISOString().slice(0, 10);
  const path = await save({
    filters: [{ name: 'Psysonic Backup', extensions: ['psybkp'] }],
    defaultPath: `psysonic-backup-${today}.psybkp`,
  });

  if (!path) return null;

  const content = JSON.stringify(manifest, null, 2);
  await writeFile(path, new TextEncoder().encode(content));
  return path;
}

export async function importBackup(): Promise<void> {
  const path = await openDialog({
    filters: [{ name: 'Psysonic Backup', extensions: ['psybkp'] }],
    multiple: false,
    title: 'Import Psysonic Backup',
  });

  if (!path || typeof path !== 'string') return;

  const raw = await readTextFile(path);
  const manifest = JSON.parse(raw);

  if (typeof manifest.version !== 'number' || !manifest.stores || typeof manifest.stores !== 'object') {
    throw new Error('invalid_backup');
  }

  for (const [key, value] of Object.entries(manifest.stores)) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  window.location.reload();
}
