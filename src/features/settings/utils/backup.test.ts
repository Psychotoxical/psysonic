import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeFile: vi.fn(),
  invoke: vi.fn(),
  backupImportLibraryDb: vi.fn(),
  backupRollbackImportedDatabases: vi.fn(),
  backupCommitImportedDatabases: vi.fn(),
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
  },
}));

import {
  activateFullBackupOrRollback,
  exportBackupToPath,
  importDatabaseBackupFromPath,
  installImportedBackupCoordinator,
  restoreBackupStores,
} from './backup';

beforeEach(() => {
  mocks.writeFile.mockReset();
  mocks.invoke.mockReset().mockResolvedValue(7);
  mocks.backupImportLibraryDb.mockReset().mockResolvedValue({ status: 'ok', data: null });
  mocks.backupRollbackImportedDatabases.mockReset().mockResolvedValue({ status: 'ok', data: null });
  mocks.backupCommitImportedDatabases.mockReset().mockResolvedValue({ status: 'ok', data: null });
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
    );
    expect(JSON.parse(localStorage.getItem('psysonic_theme') ?? 'null')).toBe('canonical');
    cleanup();
  });

  it('retains database rollback copies until migration startup reaches a terminal state', async () => {
    const cleanup = installImportedBackupCoordinator({
      arm: vi.fn(),
      disarm: vi.fn(),
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
    const cleanup = installImportedBackupCoordinator({
      arm: vi.fn(),
      disarm,
      normalizeStores: () => ({ psysonic_theme: cyclic }),
      prepareDatabaseImport: () => ({
        serverIds: ['music.test'],
        canonicalServerIds: ['music.test'],
        rollbackCheckpoint,
      }),
    });

    await expect(activateFullBackupOrRollback('/tmp/full.psyfull', {}))
      .rejects.toThrow('circular');

    expect(mocks.backupRollbackImportedDatabases).toHaveBeenCalledWith(7);
    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_release', { generation: 7 });
    expect(JSON.parse(localStorage.getItem('psysonic_theme') ?? 'null')).toBe('previous');
    expect(rollbackCheckpoint).toHaveBeenCalledOnce();
    expect(disarm).toHaveBeenCalledOnce();
    cleanup();
  });
});
