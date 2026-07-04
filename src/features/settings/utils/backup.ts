import { save, open as openDialog } from '@tauri-apps/plugin-dialog';
import { writeFile, readTextFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { commands } from '@/generated/bindings';
import { version as appVersion } from '@/../package.json';

const BACKUP_VERSION = 1;
export type ImportedBackupKind = 'config' | 'databases' | 'full';
export type BackupExportMode = 'full' | 'library' | 'config';

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
  'psysonic_player_prefs',
  'psysonic_queue_visible',
  'psysonic_lastfm_loved_cache',
  'psysonic_home',
];

function collectStores(): Record<string, unknown> {
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
  return stores;
}

function buildSettingsManifest() {
  return {
    version: BACKUP_VERSION,
    app_version: appVersion,
    created_at: new Date().toISOString(),
    stores: collectStores(),
  };
}

export async function pickBackupExportPath(mode: BackupExportMode): Promise<string | null> {
  const today = new Date().toISOString().slice(0, 10);
  if (mode === 'full') {
    return save({
      filters: [{ name: 'Psysonic Full Backup', extensions: ['psyfull', 'zip'] }],
      defaultPath: `psysonic-full-${today}.psyfull`,
    });
  }
  if (mode === 'library') {
    return save({
      filters: [{ name: 'Psysonic Library Databases Archive', extensions: ['psylib', 'zip'] }],
      defaultPath: `psysonic-library-databases-${today}.psylib`,
    });
  }
  return save({
    filters: [{ name: 'Psysonic Backup', extensions: ['psybkp'] }],
    defaultPath: `psysonic-backup-${today}.psybkp`,
  });
}

export async function exportBackupToPath(mode: BackupExportMode, path: string): Promise<void> {
  if (mode === 'full') {
    await invoke('backup_export_full', {
      destinationPath: path,
      stores: collectStores(),
      appVersion,
    });
    return;
  }
  if (mode === 'library') {
    const res = await commands.backupExportLibraryDb(path);
    if (res.status === 'error') throw new Error(res.error);
    return;
  }
  const content = JSON.stringify(buildSettingsManifest(), null, 2);
  await writeFile(path, new TextEncoder().encode(content));
}

export async function pickBackupImportPath(): Promise<string | null> {
  const path = await openDialog({
    filters: [{ name: 'Psysonic Backup', extensions: ['psybkp', 'psylib', 'psyfull', 'zip'] }],
    multiple: false,
    title: 'Import Backup',
  });
  return path && typeof path === 'string' ? path : null;
}

export async function importAnyBackupFromPath(path: string): Promise<ImportedBackupKind> {
  try {
    const raw = await readTextFile(path);
    const manifest = JSON.parse(raw);
    if (typeof manifest.version === 'number' && manifest.stores && typeof manifest.stores === 'object') {
      for (const [key, value] of Object.entries(manifest.stores as Record<string, unknown>)) {
        localStorage.setItem(key, JSON.stringify(value));
      }
      window.location.reload();
      return 'config';
    }
  } catch {
    // Not a plain JSON settings backup, continue detection.
  }

  try {
    const stores = await invoke<Record<string, unknown>>('backup_import_full', { sourcePath: path });
    for (const [key, value] of Object.entries(stores)) {
      localStorage.setItem(key, JSON.stringify(value));
    }
    window.location.reload();
    return 'full';
  } catch {
    // Not a full backup archive, continue detection.
  }

  const res = await commands.backupImportLibraryDb(path);
  if (res.status === 'error') throw new Error(res.error);
  return 'databases';
}

export async function exportBackup(): Promise<string | null> {
  const path = await pickBackupExportPath('config');
  if (!path) return null;
  await exportBackupToPath('config', path);
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

export async function exportLibraryDatabaseBackup(): Promise<string | null> {
  const path = await pickBackupExportPath('library');
  if (!path) return null;
  await exportBackupToPath('library', path);
  return path;
}

export async function importLibraryDatabaseBackup(): Promise<void> {
  const path = await openDialog({
    filters: [{ name: 'Psysonic Library Databases Archive', extensions: ['psylib', 'zip'] }],
    multiple: false,
    title: 'Import Library Databases Archive',
  });
  if (!path || typeof path !== 'string') return;
  const res = await commands.backupImportLibraryDb(path);
  if (res.status === 'error') throw new Error(res.error);
}

export async function exportFullBackup(): Promise<string | null> {
  const path = await pickBackupExportPath('full');
  if (!path) return null;
  await exportBackupToPath('full', path);
  return path;
}

export async function importFullBackup(): Promise<void> {
  const path = await openDialog({
    filters: [{ name: 'Psysonic Full Backup', extensions: ['psyfull', 'zip'] }],
    multiple: false,
    title: 'Import Full Backup',
  });
  if (!path || typeof path !== 'string') return;
  const stores = await invoke<Record<string, unknown>>('backup_import_full', { sourcePath: path });
  for (const [key, value] of Object.entries(stores)) {
    localStorage.setItem(key, JSON.stringify(value));
  }
  window.location.reload();
}

export async function importAnyBackup(): Promise<ImportedBackupKind | null> {
  const path = await pickBackupImportPath();
  if (!path) return null;
  return importAnyBackupFromPath(path);
}
