import { save, open as openDialog } from '@tauri-apps/plugin-dialog';
import { writeFile, readTextFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import {
  commands,
  type FullImportRecoveryStatusDto,
  type MigrationBeginResultDto,
  type MigrationGenerationSnapshotDto,
} from '@/generated/bindings';
import { version as appVersion } from '@/../package.json';

const BACKUP_VERSION = 1;
export type ImportedBackupKind = 'config' | 'databases' | 'full';
export type BackupExportMode = 'full' | 'library' | 'config';
export type ImportedBackupCoordinator = {
  arm: () => void;
  disarm: () => void;
  captureRecoveryState: () => Record<string, string | null>;
  restoreRecoveryState: (snapshot: Record<string, string | null>) => void;
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
export const FULL_BACKUP_IMPORT_JOURNAL_KEY = 'psysonic-full-backup-import-journal-v1';

type FullBackupImportJournal = {
  version: 1;
  phase: 'prepared' | 'activated';
  migrationGeneration: number | null;
  previousStores: Record<string, string | null>;
  previousCoordinatorState: Record<string, string | null>;
};

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

function captureBackupStoreSnapshot(): Record<string, string | null> {
  return Object.fromEntries(BACKUP_KEYS.map(key => [key, localStorage.getItem(key)]));
}

function restoreBackupStoreSnapshot(snapshot: Record<string, string | null>): void {
  for (const key of BACKUP_KEYS) localStorage.removeItem(key);
  for (const key of BACKUP_KEYS) {
    const value = snapshot[key] ?? null;
    if (value === null) continue;
    localStorage.setItem(key, value);
  }
  for (const key of BACKUP_KEYS) {
    const expected = snapshot[key] ?? null;
    if (localStorage.getItem(key) !== expected) throw new Error(`backup_store_rollback_failed:${key}`);
  }
}

function writeFullBackupImportJournal(journal: FullBackupImportJournal): void {
  const serialized = JSON.stringify(journal);
  localStorage.setItem(FULL_BACKUP_IMPORT_JOURNAL_KEY, serialized);
  if (localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY) !== serialized) {
    throw new Error('full_backup_import_journal_write_failed');
  }
}

function readFullBackupImportJournal(): FullBackupImportJournal | null {
  const raw = localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('full_backup_import_journal_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('full_backup_import_journal_invalid');
  }
  const journal = parsed as Partial<FullBackupImportJournal>;
  if (journal.version !== 1
    || (journal.phase !== 'prepared' && journal.phase !== 'activated')
    || (journal.migrationGeneration !== null && typeof journal.migrationGeneration !== 'number')
    || !journal.previousStores || typeof journal.previousStores !== 'object'
    || !journal.previousCoordinatorState || typeof journal.previousCoordinatorState !== 'object') {
    throw new Error('full_backup_import_journal_invalid');
  }
  for (const key of BACKUP_KEYS) {
    const value = journal.previousStores[key];
    if (value !== null && typeof value !== 'string') {
      throw new Error(`full_backup_import_journal_invalid:${key}`);
    }
  }
  for (const value of Object.values(journal.previousCoordinatorState)) {
    if (value !== null && typeof value !== 'string') {
      throw new Error('full_backup_import_journal_invalid:coordinator');
    }
  }
  return journal as FullBackupImportJournal;
}

function clearFullBackupImportJournal(): void {
  localStorage.removeItem(FULL_BACKUP_IMPORT_JOURNAL_KEY);
  if (localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY) !== null) {
    throw new Error('full_backup_import_journal_clear_failed');
  }
}

function unwrapCommand<T>(result: { status: 'ok'; data: T } | { status: 'error'; error: string }): T {
  if (result.status === 'error') throw new Error(result.error);
  return result.data;
}

async function inspectFullImportRecovery(): Promise<FullImportRecoveryStatusDto | null> {
  return unwrapCommand(await commands.backupInspectFullImportRecovery());
}

async function recoverFullImportDatabases(): Promise<void> {
  unwrapCommand(await commands.backupRecoverFullImportDatabases());
}

async function finalizeFullImportRecovery(): Promise<void> {
  unwrapCommand(await commands.backupFinalizeFullImportRecovery());
}

async function beginBackupMigrationGeneration(serverIds: string[]): Promise<number> {
  const result = await invoke<MigrationBeginResultDto>('library_migration_begin', { serverIds });
  return result.generation;
}

async function releaseBackupMigrationGeneration(generation: number | null): Promise<void> {
  if (generation === null) return;
  await invoke('library_migration_release', { generation });
}

async function releaseInterruptedBackupMigrationGeneration(
  journalGeneration: number | null,
  markerGeneration: number | null,
  beforeRelease: () => void,
): Promise<void> {
  const snapshot = unwrapCommand<MigrationGenerationSnapshotDto>(
    await commands.libraryMigrationInspect(),
  );
  if (snapshot.state === 'inactive') {
    beforeRelease();
    return;
  }
  if (journalGeneration !== null
    && markerGeneration !== null
    && journalGeneration !== markerGeneration) {
    throw new Error(
      `full_backup_import_persisted_generation_mismatch: journal=${journalGeneration}, marker=${markerGeneration}`,
    );
  }
  const knownGeneration = journalGeneration ?? markerGeneration;
  if (knownGeneration === null || snapshot.generation !== knownGeneration) {
    throw new Error(
      `full_backup_import_active_generation_mismatch: persisted=${knownGeneration ?? 'none'}, active=${snapshot.generation}`,
    );
  }
  beforeRelease();
  await releaseBackupMigrationGeneration(snapshot.generation);
}

async function rollbackFullBackupImport(
  journal: FullBackupImportJournal,
  status: FullImportRecoveryStatusDto | null,
): Promise<void> {
  const coordinator = requireImportedBackupCoordinator();
  if (status?.phase === 'committed') {
    throw new Error('full_backup_import_already_committed');
  }
  if (status) await recoverFullImportDatabases();
  await releaseInterruptedBackupMigrationGeneration(
    journal.migrationGeneration,
    status?.migrationGeneration ?? null,
    () => {
      restoreBackupStoreSnapshot(journal.previousStores);
      coordinator.restoreRecoveryState(journal.previousCoordinatorState);
    },
  );
  coordinator.disarm();
  await finalizeFullImportRecovery();
  clearFullBackupImportJournal();
}

/** Reconcile a crashed full import before auth/checkpoint readers are allowed to run. */
export async function reconcileFullBackupImportRecovery(): Promise<void> {
  const journal = readFullBackupImportJournal();
  const status = await inspectFullImportRecovery();

  if (status?.phase === 'committed') {
    if (journal && journal.phase !== 'activated') {
      throw new Error('full_backup_import_committed_with_unactivated_journal');
    }
    await finalizeFullImportRecovery();
    if (journal) clearFullBackupImportJournal();
    return;
  }

  if (!status) {
    if (!journal) return;
    if (journal.phase === 'activated') {
      clearFullBackupImportJournal();
      return;
    }
    const coordinator = requireImportedBackupCoordinator();
    await releaseInterruptedBackupMigrationGeneration(
      journal.migrationGeneration,
      null,
      () => {
        restoreBackupStoreSnapshot(journal.previousStores);
        coordinator.restoreRecoveryState(journal.previousCoordinatorState);
      },
    );
    coordinator.disarm();
    clearFullBackupImportJournal();
    return;
  }

  if (status.phase === 'prepared' && journal?.phase === 'activated') {
    return;
  }

  if (!journal) {
    await recoverFullImportDatabases();
    throw new Error('full_backup_import_journal_missing_after_database_recovery');
  }
  await rollbackFullBackupImport(journal, {
    ...status,
    phase: 'databases-restored',
  });
}

export async function commitImportedBackupRecovery(): Promise<void> {
  const journal = readFullBackupImportJournal();
  if (journal && journal.phase !== 'activated') {
    throw new Error('full_backup_import_not_activated');
  }
  unwrapCommand(await commands.backupCommitImportedDatabases());
  if (journal) clearFullBackupImportJournal();
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
      false,
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
  let journal: FullBackupImportJournal = {
    version: 1,
    phase: 'prepared',
    migrationGeneration: null,
    previousStores: captureBackupStoreSnapshot(),
    previousCoordinatorState: coordinator.captureRecoveryState(),
  };
  writeFullBackupImportJournal(journal);
  try {
    const normalized = coordinator.normalizeStores(filterBackupStores(stores));
    const plan = coordinator.prepareDatabaseImport(normalized);
    const generation = await beginBackupMigrationGeneration(plan.serverIds);
    journal = { ...journal, migrationGeneration: generation };
    writeFullBackupImportJournal(journal);
    const imported = await commands.backupImportLibraryDb(
      path,
      plan.canonicalServerIds,
      generation,
      true,
    );
    if (imported.status === 'error') throw new Error(imported.error);
    restoreBackupStores(normalized);
    journal = { ...journal, phase: 'activated' };
    writeFullBackupImportJournal(journal);
  } catch (error) {
    let rollbackError: unknown = null;
    try {
      await rollbackFullBackupImport(journal, await inspectFullImportRecovery());
    } catch (caught) {
      rollbackError = caught;
    }
    if (rollbackError) window.location.reload();
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
