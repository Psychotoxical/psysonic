import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeFile: vi.fn(),
  invoke: vi.fn(),
  backupImportLibraryDb: vi.fn(),
  backupRollbackImportedDatabases: vi.fn(),
  backupCommitImportedDatabases: vi.fn(),
  backupInspectFullImportRecovery: vi.fn(),
  backupRecoverFullImportDatabases: vi.fn(),
  backupFinalizeFullImportRecovery: vi.fn(),
  libraryMigrationInspect: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
  open: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: mocks.writeFile,
  readTextFile: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/generated/bindings', () => ({
  commands: {
    backupExportLibraryDb: vi.fn(),
    backupImportLibraryDb: mocks.backupImportLibraryDb,
    backupRollbackImportedDatabases: mocks.backupRollbackImportedDatabases,
    backupCommitImportedDatabases: mocks.backupCommitImportedDatabases,
    backupInspectFullImportRecovery: mocks.backupInspectFullImportRecovery,
    backupRecoverFullImportDatabases: mocks.backupRecoverFullImportDatabases,
    backupFinalizeFullImportRecovery: mocks.backupFinalizeFullImportRecovery,
    libraryMigrationInspect: mocks.libraryMigrationInspect,
  },
}));

import {
  activateFullBackupOrRollback,
  commitImportedBackupRecovery,
  FULL_BACKUP_IMPORT_JOURNAL_KEY,
  exportBackupToPath,
  importDatabaseBackupFromPath,
  installImportedBackupCoordinator,
  reconcileFullBackupImportRecovery,
  restoreBackupStores,
} from './backup';

beforeEach(() => {
  mocks.writeFile.mockReset();
  mocks.invoke.mockReset().mockImplementation(async (command: string) => (
    command === 'library_migration_begin'
      ? {
          generation: 7,
          created: true,
          servers: [{ serverId: 'music.test', previousPhase: null }],
        }
      : undefined
  ));
  mocks.backupImportLibraryDb.mockReset().mockResolvedValue({ status: 'ok', data: null });
  mocks.backupRollbackImportedDatabases.mockReset().mockResolvedValue({ status: 'ok', data: null });
  mocks.backupCommitImportedDatabases.mockReset().mockResolvedValue({ status: 'ok', data: null });
  mocks.backupInspectFullImportRecovery.mockReset().mockResolvedValue({ status: 'ok', data: null });
  mocks.backupRecoverFullImportDatabases.mockReset().mockResolvedValue({ status: 'ok', data: null });
  mocks.backupFinalizeFullImportRecovery.mockReset().mockResolvedValue({ status: 'ok', data: null });
  mocks.libraryMigrationInspect.mockReset().mockResolvedValue({
    status: 'ok',
    data: { state: 'inactive', lastGeneration: 0 },
  });
  localStorage.clear();
});

describe('settings backup stores', () => {
  it('round-trips visualizer preferences and Now Playing card layout', async () => {
    const visualizer = { state: { enabled: true, mode: 'radial', fps: 45 }, version: 0 };
    const layout = {
      state: {
        cards: [{ id: 'visualizer', column: 'right', visible: false }],
      },
      version: 0,
    };
    localStorage.setItem('psysonic_visualizer', JSON.stringify(visualizer));
    localStorage.setItem('psysonic_np_layout', JSON.stringify(layout));

    await exportBackupToPath('config', '/tmp/settings.psybkp');
    const bytes = mocks.writeFile.mock.calls[0]?.[1] as Uint8Array;
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
      stores: Record<string, unknown>;
    };
    expect(manifest.stores.psysonic_visualizer).toEqual(visualizer);
    expect(manifest.stores.psysonic_np_layout).toEqual(layout);

    localStorage.clear();
    restoreBackupStores(manifest.stores);
    expect(JSON.parse(localStorage.getItem('psysonic_visualizer') ?? 'null')).toEqual(visualizer);
    expect(JSON.parse(localStorage.getItem('psysonic_np_layout') ?? 'null')).toEqual(layout);
  });

  it('restores only allowlisted stores and removes allowlisted values absent from the backup', () => {
    localStorage.setItem('psysonic-player', JSON.stringify({ state: { currentTrack: 'old' } }));
    restoreBackupStores({
      psysonic_theme: 'dark',
      unexpected_store: { unsafe: true },
    });

    expect(localStorage.getItem('psysonic-player')).toBeNull();
    expect(JSON.parse(localStorage.getItem('psysonic_theme') ?? 'null')).toBe('dark');
    expect(localStorage.getItem('unexpected_store')).toBeNull();
  });

  it('activates normalized full-backup stores under a migration generation', async () => {
    const cleanup = installImportedBackupCoordinator({
      arm: vi.fn(),
      disarm: vi.fn(),
      captureRecoveryState: () => ({ checkpoint: 'previous-checkpoint' }),
      restoreRecoveryState: vi.fn(),
      normalizeStores: stores => ({ ...stores, psysonic_theme: 'canonical' }),
      prepareDatabaseImport: () => ({
        serverIds: ['music.test'],
        canonicalServerIds: ['music.test'],
        rollbackCheckpoint: vi.fn(),
      }),
    });

    await activateFullBackupOrRollback('/tmp/full.psyfull', { psysonic_theme: 'legacy' });

    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_begin', {
      serverIds: ['music.test'],
    });
    expect(mocks.backupImportLibraryDb).toHaveBeenCalledWith(
      '/tmp/full.psyfull',
      ['music.test'],
      7,
      true,
    );
    expect(JSON.parse(localStorage.getItem('psysonic_theme') ?? 'null')).toBe('canonical');
    expect(JSON.parse(localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY) ?? '{}')).toMatchObject({
      version: 1,
      phase: 'activated',
      migrationGeneration: 7,
      previousCoordinatorState: { checkpoint: 'previous-checkpoint' },
    });
    cleanup();
  });

  it('retains database rollback copies until migration startup reaches a terminal state', async () => {
    const cleanup = installImportedBackupCoordinator({
      arm: vi.fn(),
      disarm: vi.fn(),
      captureRecoveryState: () => ({}),
      restoreRecoveryState: vi.fn(),
      normalizeStores: stores => stores,
      prepareDatabaseImport: () => ({
        serverIds: ['music.test'],
        canonicalServerIds: ['music.test'],
        rollbackCheckpoint: vi.fn(),
      }),
    });

    await importDatabaseBackupFromPath('/tmp/library.psylib');

    expect(mocks.backupImportLibraryDb).toHaveBeenCalledWith(
      '/tmp/library.psylib',
      ['music.test'],
      7,
      false,
    );
    expect(mocks.backupCommitImportedDatabases).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith('library_migration_release', expect.anything());
    cleanup();
  });

  it('rolls databases, stores, checkpoint, and generation back when store activation fails', async () => {
    localStorage.setItem('psysonic_theme', JSON.stringify('previous'));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const rollbackCheckpoint = vi.fn();
    const disarm = vi.fn();
    const restoreRecoveryState = vi.fn();
    const cleanup = installImportedBackupCoordinator({
      arm: vi.fn(),
      disarm,
      captureRecoveryState: () => ({ checkpoint: 'previous' }),
      restoreRecoveryState,
      normalizeStores: () => ({ psysonic_theme: cyclic }),
      prepareDatabaseImport: () => ({
        serverIds: ['music.test'],
        canonicalServerIds: ['music.test'],
        rollbackCheckpoint,
      }),
    });
    mocks.backupInspectFullImportRecovery.mockResolvedValue({
      status: 'ok',
      data: { phase: 'prepared', migrationGeneration: 7 },
    });
    mocks.libraryMigrationInspect.mockResolvedValue({
      status: 'ok',
      data: { state: 'active', generation: 7, servers: [{ serverId: 'music.test', phase: 'pending' }] },
    });

    await expect(activateFullBackupOrRollback('/tmp/full.psyfull', {}))
      .rejects.toThrow('circular');

    expect(mocks.backupRecoverFullImportDatabases).toHaveBeenCalledOnce();
    expect(mocks.backupFinalizeFullImportRecovery).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_release', { generation: 7 });
    expect(JSON.parse(localStorage.getItem('psysonic_theme') ?? 'null')).toBe('previous');
    expect(restoreRecoveryState).toHaveBeenCalledWith({ checkpoint: 'previous' });
    expect(rollbackCheckpoint).not.toHaveBeenCalled();
    expect(disarm).toHaveBeenCalledOnce();
    expect(localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY)).toBeNull();
    cleanup();
  });

  it('startup restores databases, exact previous stores, and coordinator state for a prepared journal', async () => {
    localStorage.setItem('psysonic_theme', JSON.stringify('previous'));
    const restoreRecoveryState = vi.fn();
    const disarm = vi.fn();
    const cleanup = installImportedBackupCoordinator({
      arm: vi.fn(),
      disarm,
      captureRecoveryState: () => ({ checkpoint: 'previous-checkpoint' }),
      restoreRecoveryState,
      normalizeStores: stores => stores,
      prepareDatabaseImport: () => ({
        serverIds: ['music.test'],
        canonicalServerIds: ['music.test'],
        rollbackCheckpoint: vi.fn(),
      }),
    });
    await activateFullBackupOrRollback('/tmp/full.psyfull', { psysonic_theme: 'imported' });
    const journal = JSON.parse(localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY) ?? '{}');
    journal.phase = 'prepared';
    localStorage.setItem(FULL_BACKUP_IMPORT_JOURNAL_KEY, JSON.stringify(journal));
    mocks.backupInspectFullImportRecovery.mockResolvedValue({
      status: 'ok',
      data: { phase: 'prepared', migrationGeneration: 7 },
    });
    mocks.libraryMigrationInspect.mockResolvedValue({
      status: 'ok',
      data: { state: 'active', generation: 7, servers: [{ serverId: 'music.test', phase: 'pending' }] },
    });

    await reconcileFullBackupImportRecovery();

    expect(JSON.parse(localStorage.getItem('psysonic_theme') ?? 'null')).toBe('previous');
    expect(restoreRecoveryState).toHaveBeenCalledWith({ checkpoint: 'previous-checkpoint' });
    expect(mocks.backupRecoverFullImportDatabases).toHaveBeenCalledOnce();
    expect(mocks.backupFinalizeFullImportRecovery).toHaveBeenCalledOnce();
    expect(disarm).toHaveBeenCalledOnce();
    expect(localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY)).toBeNull();
    cleanup();
  });

  it('startup preserves an activated import while its canonical migration is pending', async () => {
    const cleanup = installImportedBackupCoordinator({
      arm: vi.fn(),
      disarm: vi.fn(),
      captureRecoveryState: () => ({}),
      restoreRecoveryState: vi.fn(),
      normalizeStores: stores => stores,
      prepareDatabaseImport: () => ({
        serverIds: [], canonicalServerIds: [], rollbackCheckpoint: vi.fn(),
      }),
    });
    await activateFullBackupOrRollback('/tmp/full.psyfull', { psysonic_theme: 'imported' });
    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_begin', { serverIds: [] });
    expect(JSON.parse(localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY) ?? '{}'))
      .toMatchObject({ migrationGeneration: 7 });
    mocks.backupInspectFullImportRecovery.mockResolvedValue({
      status: 'ok',
      data: { phase: 'prepared', migrationGeneration: 7 },
    });

    await reconcileFullBackupImportRecovery();

    expect(JSON.parse(localStorage.getItem('psysonic_theme') ?? 'null')).toBe('imported');
    expect(mocks.backupRecoverFullImportDatabases).not.toHaveBeenCalled();
    expect(localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY)).not.toBeNull();
    cleanup();
  });

  it('startup clears an activated journal when the committed Rust marker is already gone', async () => {
    const cleanup = installImportedBackupCoordinator({
      arm: vi.fn(),
      disarm: vi.fn(),
      captureRecoveryState: () => ({}),
      restoreRecoveryState: vi.fn(),
      normalizeStores: stores => stores,
      prepareDatabaseImport: () => ({
        serverIds: [], canonicalServerIds: [], rollbackCheckpoint: vi.fn(),
      }),
    });
    await activateFullBackupOrRollback('/tmp/full.psyfull', { psysonic_theme: 'imported' });

    await reconcileFullBackupImportRecovery();

    expect(JSON.parse(localStorage.getItem('psysonic_theme') ?? 'null')).toBe('imported');
    expect(localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY)).toBeNull();
    cleanup();
  });

  it('startup treats a persisted generation as already released after runtime restart', async () => {
    localStorage.setItem('psysonic_theme', JSON.stringify('previous'));
    const restoreRecoveryState = vi.fn();
    const cleanup = installImportedBackupCoordinator({
      arm: vi.fn(),
      disarm: vi.fn(),
      captureRecoveryState: () => ({ checkpoint: 'previous-checkpoint' }),
      restoreRecoveryState,
      normalizeStores: stores => stores,
      prepareDatabaseImport: () => ({
        serverIds: [], canonicalServerIds: [], rollbackCheckpoint: vi.fn(),
      }),
    });
    await activateFullBackupOrRollback('/tmp/full.psyfull', { psysonic_theme: 'imported' });
    const journal = JSON.parse(localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY) ?? '{}');
    journal.phase = 'prepared';
    localStorage.setItem(FULL_BACKUP_IMPORT_JOURNAL_KEY, JSON.stringify(journal));

    await reconcileFullBackupImportRecovery();

    expect(JSON.parse(localStorage.getItem('psysonic_theme') ?? 'null')).toBe('previous');
    expect(restoreRecoveryState).toHaveBeenCalledWith({ checkpoint: 'previous-checkpoint' });
    expect(mocks.backupRecoverFullImportDatabases).not.toHaveBeenCalled();
    expect(mocks.libraryMigrationInspect).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalledWith('library_migration_release', expect.anything());
    expect(localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY)).toBeNull();
    cleanup();
  });

  it('restart restores an empty-generation durable import while runtime is inactive', async () => {
    localStorage.setItem('psysonic_theme', JSON.stringify('previous'));
    const restoreRecoveryState = vi.fn();
    const cleanup = installImportedBackupCoordinator({
      arm: vi.fn(),
      disarm: vi.fn(),
      captureRecoveryState: () => ({ checkpoint: 'previous-checkpoint' }),
      restoreRecoveryState,
      normalizeStores: stores => stores,
      prepareDatabaseImport: () => ({
        serverIds: [], canonicalServerIds: [], rollbackCheckpoint: vi.fn(),
      }),
    });
    await activateFullBackupOrRollback('/tmp/full.psyfull', { psysonic_theme: 'imported' });
    const journal = JSON.parse(localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY) ?? '{}');
    journal.phase = 'prepared';
    localStorage.setItem(FULL_BACKUP_IMPORT_JOURNAL_KEY, JSON.stringify(journal));
    mocks.backupInspectFullImportRecovery.mockResolvedValue({
      status: 'ok',
      data: { phase: 'prepared', migrationGeneration: 7 },
    });

    await reconcileFullBackupImportRecovery();

    expect(mocks.backupRecoverFullImportDatabases).toHaveBeenCalledOnce();
    expect(mocks.libraryMigrationInspect).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalledWith('library_migration_release', expect.anything());
    expect(JSON.parse(localStorage.getItem('psysonic_theme') ?? 'null')).toBe('previous');
    expect(restoreRecoveryState).toHaveBeenCalledWith({ checkpoint: 'previous-checkpoint' });
    expect(localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY)).toBeNull();
    cleanup();
  });

  it('startup fails explicitly instead of releasing a different active generation', async () => {
    const cleanup = installImportedBackupCoordinator({
      arm: vi.fn(),
      disarm: vi.fn(),
      captureRecoveryState: () => ({}),
      restoreRecoveryState: vi.fn(),
      normalizeStores: stores => stores,
      prepareDatabaseImport: () => ({
        serverIds: [], canonicalServerIds: [], rollbackCheckpoint: vi.fn(),
      }),
    });
    await activateFullBackupOrRollback('/tmp/full.psyfull', { psysonic_theme: 'imported' });
    const journal = JSON.parse(localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY) ?? '{}');
    journal.phase = 'prepared';
    localStorage.setItem(FULL_BACKUP_IMPORT_JOURNAL_KEY, JSON.stringify(journal));
    mocks.libraryMigrationInspect.mockResolvedValue({
      status: 'ok',
      data: { state: 'active', generation: 8, servers: [] },
    });

    await expect(reconcileFullBackupImportRecovery())
      .rejects.toThrow('full_backup_import_active_generation_mismatch: persisted=7, active=8');

    expect(mocks.invoke).not.toHaveBeenCalledWith('library_migration_release', expect.anything());
    expect(localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY)).not.toBeNull();
    cleanup();
  });

  it('startup restores the database pair but blocks when the frontend journal is missing', async () => {
    const cleanup = installImportedBackupCoordinator({
      arm: vi.fn(),
      disarm: vi.fn(),
      captureRecoveryState: () => ({}),
      restoreRecoveryState: vi.fn(),
      normalizeStores: stores => stores,
      prepareDatabaseImport: () => ({
        serverIds: [], canonicalServerIds: [], rollbackCheckpoint: vi.fn(),
      }),
    });
    mocks.backupInspectFullImportRecovery.mockResolvedValue({
      status: 'ok',
      data: { phase: 'prepared', migrationGeneration: 7 },
    });

    await expect(reconcileFullBackupImportRecovery())
      .rejects.toThrow('full_backup_import_journal_missing_after_database_recovery');

    expect(mocks.backupRecoverFullImportDatabases).toHaveBeenCalledOnce();
    expect(mocks.backupFinalizeFullImportRecovery).not.toHaveBeenCalled();
    cleanup();
  });

  it('startup finalizes a committed marker without rolling back imported stores', async () => {
    const cleanup = installImportedBackupCoordinator({
      arm: vi.fn(),
      disarm: vi.fn(),
      captureRecoveryState: () => ({}),
      restoreRecoveryState: vi.fn(),
      normalizeStores: stores => stores,
      prepareDatabaseImport: () => ({
        serverIds: [], canonicalServerIds: [], rollbackCheckpoint: vi.fn(),
      }),
    });
    await activateFullBackupOrRollback('/tmp/full.psyfull', { psysonic_theme: 'imported' });
    mocks.backupInspectFullImportRecovery.mockResolvedValue({
      status: 'ok',
      data: { phase: 'committed', migrationGeneration: 7 },
    });

    await reconcileFullBackupImportRecovery();

    expect(mocks.backupFinalizeFullImportRecovery).toHaveBeenCalledOnce();
    expect(mocks.backupRecoverFullImportDatabases).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('psysonic_theme') ?? 'null')).toBe('imported');
    expect(localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY)).toBeNull();
    cleanup();
  });

  it('does not clear the activated journal when coordinator cleanup fails', async () => {
    const cleanup = installImportedBackupCoordinator({
      arm: vi.fn(),
      disarm: vi.fn(),
      captureRecoveryState: () => ({}),
      restoreRecoveryState: vi.fn(),
      normalizeStores: stores => stores,
      prepareDatabaseImport: () => ({
        serverIds: [], canonicalServerIds: [], rollbackCheckpoint: vi.fn(),
      }),
    });
    await activateFullBackupOrRollback('/tmp/full.psyfull', { psysonic_theme: 'imported' });
    mocks.backupCommitImportedDatabases.mockResolvedValue({
      status: 'error',
      error: 'injected cleanup failure',
    });

    await expect(commitImportedBackupRecovery()).rejects.toThrow('injected cleanup failure');

    expect(JSON.parse(localStorage.getItem(FULL_BACKUP_IMPORT_JOURNAL_KEY) ?? '{}').phase)
      .toBe('activated');
    cleanup();
  });
});
