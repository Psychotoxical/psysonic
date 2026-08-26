import { save, open as openDialog } from '@tauri-apps/plugin-dialog';
import { writeFile, readTextFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { commands } from '@/generated/bindings';
import { version as appVersion } from '@/../package.json';

const BACKUP_VERSION = 1;
export type ImportedBackupKind = 'config' | 'databases' | 'full';
export type BackupExportMode = 'full' | 'library' | 'config';
export type ImportedBackupCoordinator = {
  arm: () => void;
  disarm: () => void;
  normalizeStores: (stores: Record<string, unknown>) => Record<string, unknown>;
  prepareDatabaseImport: (stores?: Record<string, unknown>) => {
    serverIds: string[];
    canonicalServerIds: string[];
    rollbackCheckpoint: () => void;
  };
};

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
  'psysonic_visualizer',
  'psysonic_np_layout',
] as const;
const BACKUP_KEY_SET = new Set<string>(BACKUP_KEYS);
let importedBackupCoordinator: ImportedBackupCoordinator | null = null;

/** Install the app-layer normalize-before-activation gate for imported stores. */
export function installImportedBackupCoordinator(
  coordinator: ImportedBackupCoordinator,
): () => void {
  importedBackupCoordinator = coordinator;
  return () => {
    if (importedBackupCoordinator === coordinator) importedBackupCoordinator = null;
  };
}

function filterBackupStores(stores: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(stores).filter(([key]) => BACKUP_KEY_SET.has(key)));
}

function serializedStore(value: unknown, key: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`invalid_backup_store:${key}`);
  return serialized;
}

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

export function restoreBackupStores(stores: Record<string, unknown>): void {
  const filtered = filterBackupStores(stores);
  const previous = new Map(BACKUP_KEYS.map(key => [key, localStorage.getItem(key)] as const));
  try {
    for (const key of BACKUP_KEYS) localStorage.removeItem(key);
    for (const [key, value] of Object.entries(filtered)) {
      const serialized = serializedStore(value, key);
      localStorage.setItem(key, serialized);
      if (localStorage.getItem(key) !== serialized) throw new Error(`backup_store_readback_failed:${key}`);
    }
  } catch (error) {
    for (const [key, value] of previous) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
    throw error;
  }
}

function requireImportedBackupCoordinator(): ImportedBackupCoordinator {
  if (!importedBackupCoordinator) throw new Error('backup_import_normalizer_unavailable');
  return importedBackupCoordinator;
}

function captureBackupStoreSnapshot(): Map<string, string | null> {
  return new Map(BACKUP_KEYS.map(key => [key, localStorage.getItem(key)] as const));
}

function restoreBackupStoreSnapshot(snapshot: ReadonlyMap<string, string | null>): void {
  for (const key of BACKUP_KEYS) localStorage.removeItem(key);
  for (const [key, value] of snapshot) {
    if (value === null) continue;
    localStorage.setItem(key, value);
    if (localStorage.getItem(key) !== value) throw new Error(`backup_store_rollback_failed:${key}`);
  }
}

async function beginBackupMigrationGeneration(serverIds: string[]): Promise<number | null> {
  if (serverIds.length === 0) return null;
  return invoke<number>('library_migration_begin', { serverIds });
}

async function releaseBackupMigrationGeneration(generation: number | null): Promise<void> {
  if (generation === null) return;
  await invoke('library_migration_release', { generation });
}

function restoreArmedImportedBackupStores(stores: Record<string, unknown>): void {
  const normalized = requireImportedBackupCoordinator().normalizeStores(filterBackupStores(stores));
  restoreBackupStores(normalized);
}

function restoreConfigurationBackupStores(stores: Record<string, unknown>): void {
  const coordinator = requireImportedBackupCoordinator();
  coordinator.arm();
  try {
    restoreArmedImportedBackupStores(stores);
  } catch (error) {
    coordinator.disarm();
    throw error;
  }
}

export async function importDatabaseBackupFromPath(path: string): Promise<void> {
  const coordinator = requireImportedBackupCoordinator();
  coordinator.arm();
  let plan: ReturnType<ImportedBackupCoordinator['prepareDatabaseImport']> | null = null;
  let generation: number | null = null;
  try {
    plan = coordinator.prepareDatabaseImport();
    generation = await beginBackupMigrationGeneration(plan.serverIds);
    const res = await commands.backupImportLibraryDb(
      path,
      plan.canonicalServerIds,
      generation,
    );
    if (res.status === 'error') throw new Error(res.error);
  } catch (error) {
    let recoveryError: unknown = null;
    try {
      plan?.rollbackCheckpoint();
      await releaseBackupMigrationGeneration(generation);
    } catch (caught) {
      recoveryError = caught;
    }
    if (recoveryError) window.location.reload();
    else coordinator.disarm();
    if (recoveryError) {
      const recoveryFailure = new Error(
        `database_backup_recovery_failed: ${String(recoveryError)}`,
      ) as Error & { cause?: unknown };
      recoveryFailure.cause = error;
      throw recoveryFailure;
    }
    throw error;
  }
}

async function importFullBackupFromPath(path: string): Promise<Record<string, unknown>> {
  const coordinator = requireImportedBackupCoordinator();
  coordinator.arm();
  try {
    return await invoke<Record<string, unknown>>('backup_import_full', { sourcePath: path });
  } catch (error) {
    coordinator.disarm();
    throw error;
  }
}

export async function activateFullBackupOrRollback(
  path: string,
  stores: Record<string, unknown>,
): Promise<void> {
  const coordinator = requireImportedBackupCoordinator();
  const previousStores = captureBackupStoreSnapshot();
  let plan: ReturnType<ImportedBackupCoordinator['prepareDatabaseImport']> | null = null;
  let generation: number | null = null;
  let databasesActivated = false;
  try {
    const normalized = coordinator.normalizeStores(filterBackupStores(stores));
    plan = coordinator.prepareDatabaseImport(normalized);
    generation = await beginBackupMigrationGeneration(plan.serverIds);
    const imported = await commands.backupImportLibraryDb(
      path,
      plan.canonicalServerIds,
      generation,
    );
    if (imported.status === 'error') throw new Error(imported.error);
    databasesActivated = true;
    restoreBackupStores(normalized);
  } catch (error) {
    let rollbackError: unknown = null;
    if (databasesActivated) {
      const rolledBack = await commands.backupRollbackImportedDatabases(generation);
      if (rolledBack.status === 'error') rollbackError = new Error(rolledBack.error);
    }
    try {
      restoreBackupStoreSnapshot(previousStores);
      plan?.rollbackCheckpoint();
    } catch (storeRollbackError) {
      rollbackError ??= storeRollbackError;
    }
    try {
      await releaseBackupMigrationGeneration(generation);
    } catch (generationError) {
      rollbackError ??= generationError;
    }
    if (!rollbackError) coordinator.disarm();
    else window.location.reload();
    if (rollbackError) {
      const rollbackFailure = new Error(
        `full_backup_rollback_failed: ${String(rollbackError)}`,
      ) as Error & { cause?: unknown };
      rollbackFailure.cause = error;
      throw rollbackFailure;
    }
    throw error;
  }
}

function isDatabaseOnlyArchiveError(error: unknown): boolean {
  return String(error).includes('archive does not contain settings.json');
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
  let configStores: Record<string, unknown> | null = null;
  try {
    const raw = await readTextFile(path);
    const manifest = JSON.parse(raw);
    if (typeof manifest.version === 'number' && manifest.stores && typeof manifest.stores === 'object') {
      configStores = manifest.stores as Record<string, unknown>;
    }
  } catch {
    // Not a plain JSON settings backup, continue detection.
  }
  if (configStores) {
    restoreConfigurationBackupStores(configStores);
    window.location.reload();
    return 'config';
  }

  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.psylib')) {
    await importDatabaseBackupFromPath(path);
    window.location.reload();
    return 'databases';
  }

  let fullStores: Record<string, unknown> | null = null;
  try {
    fullStores = await importFullBackupFromPath(path);
  } catch (error) {
    if (lowerPath.endsWith('.psyfull') || !isDatabaseOnlyArchiveError(error)) throw error;
    // A generic .zip without settings.json is the database-only archive shape.
  }
  if (fullStores) {
    await activateFullBackupOrRollback(path, fullStores);
    window.location.reload();
    return 'full';
  }

  await importDatabaseBackupFromPath(path);
  window.location.reload();
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

  restoreConfigurationBackupStores(manifest.stores as Record<string, unknown>);

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
  await importDatabaseBackupFromPath(path);
  window.location.reload();
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
  const stores = await importFullBackupFromPath(path);
  await activateFullBackupOrRollback(path, stores);
  window.location.reload();
}

export async function importAnyBackup(): Promise<ImportedBackupKind | null> {
  const path = await pickBackupImportPath();
  if (!path) return null;
  return importAnyBackupFromPath(path);
}
