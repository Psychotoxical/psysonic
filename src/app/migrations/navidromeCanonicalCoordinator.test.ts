import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY,
  type NavidromeCanonicalMigrationCheckpointV1,
} from './navidromeCanonicalCheckpoint';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  idleHandler: null as ((event: { payload: unknown }) => void) | null,
  rewriteFrontend: vi.fn(),
  verifyFrontend: vi.fn(),
  inspectCoverUpper: vi.fn(async () => null),
  migrateCoverBatch: vi.fn(),
  verifyCover: vi.fn(async () => undefined),
  invalidateLyrics: vi.fn(async () => undefined),
  commitImportedBackupRecovery: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}));
vi.mock('./navidromeCanonicalFrontend', () => ({
  rewriteNavidromeCanonicalFrontendState: mocks.rewriteFrontend,
  verifyNavidromeCanonicalFrontendState: mocks.verifyFrontend,
}));
vi.mock('./navidromeCanonicalIdb', () => ({
  inspectNavidromeCoverIdbUpperKey: mocks.inspectCoverUpper,
  migrateNavidromeCoverIdbBatch: mocks.migrateCoverBatch,
  verifyNavidromeCoverIdb: mocks.verifyCover,
  invalidateNavidromeLyricsIdb: mocks.invalidateLyrics,
}));
vi.mock('@/features/settings/utils/backup', () => ({
  commitImportedBackupRecovery: mocks.commitImportedBackupRecovery,
}));

import {
  NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
  observeNavidromeCanonicalSuccessfulPing,
  runNavidromeCanonicalMigrationCoordinator,
} from './navidromeCanonicalCoordinator';

function seedAuth(): void {
  localStorage.setItem('psysonic-auth', JSON.stringify({
    state: {
      servers: [{
        id: 'profile',
        name: 'Music',
        url: 'https://music.test',
        username: 'user',
        password: 'password',
      }],
      activeServerId: 'profile',
      hotCacheDownloadDir: '',
    },
    version: 1,
  }));
}

function checkpoint(phase: NavidromeCanonicalMigrationCheckpointV1['servers'][string]['phase']): void {
  localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify({
    version: 1,
    servers: {
      'music.test': {
        sourceVersion: '0.64.0',
        checkedVersion: null,
        canonicalVersion: 1,
        phase,
        step: phase === 'analysis' ? 'analysis-track' : null,
        cursorRowid: 0,
        upperRowid: 0,
        cursorKey: null,
        upperKey: null,
        startedAt: 1,
        updatedAt: 1,
        localCompletedAt: null,
        syncCompletedAt: null,
        lastError: null,
      },
    },
  } satisfies NavidromeCanonicalMigrationCheckpointV1));
}

function beginResult(
  generation: number,
  created = true,
  previousPhase: NavidromeCanonicalMigrationCheckpointV1['servers'][string]['phase'] | null = null,
) {
  return {
    generation,
    created,
    servers: [{ serverId: 'music.test', previousPhase }],
  };
}

describe('runNavidromeCanonicalMigrationCoordinator', () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuth();
    mocks.invoke.mockReset();
    mocks.listen.mockReset().mockImplementation(async (_event: string, handler: (event: { payload: unknown }) => void) => {
      mocks.idleHandler = handler;
      return vi.fn();
    });
    mocks.rewriteFrontend.mockReset();
    mocks.verifyFrontend.mockReset();
    mocks.inspectCoverUpper.mockClear();
    mocks.migrateCoverBatch.mockReset();
    mocks.verifyCover.mockClear();
    mocks.invalidateLyrics.mockClear();
    mocks.commitImportedBackupRecovery.mockClear();
  });

  it('records an old stable Navidrome release without taking the writer barrier', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_inspect') return { state: 'inactive', lastGeneration: 0 };
      if (command === 'probe_server_connection') {
        return { ok: true, type: 'navidrome', serverVersion: '0.63.2', openSubsonic: true };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(runNavidromeCanonicalMigrationCoordinator({ windowKind: 'main' }))
      .resolves.toEqual({ blocked: false, migratedServers: 0 });

    const stored = JSON.parse(localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) ?? '{}');
    expect(stored.servers['music.test']).toMatchObject({
      sourceVersion: '0.63.2',
      checkedVersion: '0.63.2',
      phase: 'legacy',
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith('library_migration_begin', expect.anything());
    expect(localStorage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY)).toBeNull();
  });

  it('keeps the mini player blocked while the main bootstrap inspection lock is active', async () => {
    localStorage.setItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY, '1');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_inspect') return { state: 'inactive', lastGeneration: 0 };
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(runNavidromeCanonicalMigrationCoordinator({ windowKind: 'mini' }))
      .resolves.toEqual({ blocked: true, migratedServers: 0 });
  });

  it('releases an active empty import generation before committing retained backups', async () => {
    localStorage.removeItem('psysonic-auth');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_inspect') {
        return { state: 'active', generation: 12, servers: [] };
      }
      if (command === 'library_migration_release') return undefined;
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(runNavidromeCanonicalMigrationCoordinator({ windowKind: 'main' }))
      .resolves.toEqual({ blocked: false, migratedServers: 0 });

    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_release', { generation: 12 });
    expect(mocks.commitImportedBackupRecovery).toHaveBeenCalledOnce();
  });

  it('does not unlock an unreachable server with a destructive checkpoint', async () => {
    checkpoint('native');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_inspect') return { state: 'inactive', lastGeneration: 0 };
      if (command === 'probe_server_connection') throw new Error('offline');
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(runNavidromeCanonicalMigrationCoordinator({ windowKind: 'main' }))
      .rejects.toThrow('cannot resume while the server is unreachable');
    expect(mocks.invoke).not.toHaveBeenCalledWith('library_migration_begin', expect.anything());
    expect(localStorage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY)).toBe('1');
  });

  it('does not unlock a destructive checkpoint after its server profile is removed', async () => {
    checkpoint('analysis');
    localStorage.removeItem('psysonic-auth');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_inspect') return { state: 'inactive', lastGeneration: 0 };
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(runNavidromeCanonicalMigrationCoordinator({ windowKind: 'main' }))
      .rejects.toThrow('cannot resume because its server profile is no longer configured');
    expect(mocks.invoke).not.toHaveBeenCalledWith('library_migration_release', expect.anything());
    expect(localStorage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY)).toBe('1');
  });

  it('preserves a destructive checkpoint when the current version is retryable', async () => {
    checkpoint('native');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_inspect') return { state: 'inactive', lastGeneration: 0 };
      if (command === 'probe_server_connection') {
        return { ok: true, type: 'navidrome', serverVersion: 'custom-build', openSubsonic: true };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(runNavidromeCanonicalMigrationCoordinator({ windowKind: 'main' }))
      .rejects.toThrow('cannot discard its native checkpoint after a retryable probe');
    const stored = JSON.parse(localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) ?? '{}');
    expect(stored.servers['music.test'].phase).toBe('native');
  });

  it('finishes an imported legacy server before releasing its writer generation', async () => {
    checkpoint('pending');
    const stored = JSON.parse(localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) ?? '{}');
    stored.servers['music.test'].step = 'backup-import';
    localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify(stored));
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_inspect') {
        return { state: 'active', generation: 12, servers: [{ serverId: 'music.test', phase: 'pending' }] };
      }
      if (command === 'probe_server_connection') {
        return { ok: true, type: 'navidrome', serverVersion: '0.63.2', openSubsonic: true };
      }
      if (command === 'library_migration_finish_server' || command === 'library_migration_release') {
        return undefined;
      }
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(runNavidromeCanonicalMigrationCoordinator({ windowKind: 'main' }))
      .resolves.toEqual({ blocked: false, migratedServers: 0 });
    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_finish_server', {
      generation: 12,
      serverId: 'music.test',
      phase: 'legacy',
    });
    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_release', { generation: 12 });
  });

  it('blocks startup instead of downgrading a previously canonical namespace', async () => {
    checkpoint('ready');
    const stored = JSON.parse(localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) ?? '{}');
    stored.servers['music.test'].checkedVersion = '0.64.0';
    localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify(stored));
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_inspect') return { state: 'inactive', lastGeneration: 0 };
      if (command === 'probe_server_connection') {
        return { ok: true, type: 'navidrome', serverVersion: '0.63.2', openSubsonic: true };
      }
      if (command === 'library_migration_begin') return beginResult(10);
      if (command === 'library_migration_abort') return undefined;
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(runNavidromeCanonicalMigrationCoordinator({ windowKind: 'main' }))
      .rejects.toThrow('cannot be downgraded after 0.64.0');

    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_abort', {
      generation: 10,
      serverId: 'music.test',
      error: expect.stringContaining('cannot be downgraded after 0.64.0'),
    });
    const next = JSON.parse(localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) ?? '{}');
    expect(next.servers['music.test']).toMatchObject({
      phase: 'blocked', sourceVersion: '0.63.2', checkedVersion: '0.64.0',
    });
    expect(localStorage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY)).toBe('1');
  });

  it('inventories actual persistence before taking the same-version ready fast path', async () => {
    checkpoint('ready');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_inspect') return { state: 'inactive', lastGeneration: 0 };
      if (command === 'probe_server_connection') {
        return { ok: true, type: 'navidrome', serverVersion: '0.64.0', openSubsonic: true };
      }
      if (command === 'library_migration_inventory') return undefined;
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(runNavidromeCanonicalMigrationCoordinator({ windowKind: 'main' }))
      .resolves.toEqual({ blocked: false, migratedServers: 0 });
    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_inventory', {
      serverId: 'music.test',
      serverIndexKey: 'music.test',
      customOfflineDir: null,
      customHotCacheDir: '',
    });
    expect(mocks.verifyFrontend).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalledWith('library_migration_begin', expect.anything());
  });

  it('arms a pending writer generation before a changed runtime canonical version is published', async () => {
    checkpoint('ready');
    const stored = JSON.parse(localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) ?? '{}');
    stored.servers['music.test'].checkedVersion = '0.64.0';
    stored.servers['music.test'].localCompletedAt = 10;
    stored.servers['music.test'].syncCompletedAt = 11;
    localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify(stored));
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_begin') return beginResult(9);
      throw new Error(`Unexpected command ${command}`);
    });

    let finishAdmissionPrep!: () => void;
    const beforeAdmission = vi.fn(() => new Promise<void>(resolve => {
      expect(localStorage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY)).toMatch(/^runtime:/);
      expect(mocks.invoke).not.toHaveBeenCalledWith('library_migration_begin', expect.anything());
      finishAdmissionPrep = resolve;
    }));
    const admission = observeNavidromeCanonicalSuccessfulPing({
      profile: {
        id: 'profile', name: 'Music', url: 'https://music.test', username: 'user', password: 'password',
      },
      ping: { type: 'navidrome', serverVersion: '0.65.0' },
      beforeAdmission,
    });

    await vi.waitFor(() => expect(beforeAdmission).toHaveBeenCalledOnce());
    expect(mocks.invoke).not.toHaveBeenCalledWith('library_migration_begin', expect.anything());
    finishAdmissionPrep();
    await expect(admission).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_begin', { serverIds: ['music.test'] });
    expect(localStorage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY)).toMatch(/^runtime:/);
    const next = JSON.parse(localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) ?? '{}');
    expect(next.servers['music.test']).toMatchObject({
      phase: 'pending',
      sourceVersion: '0.65.0',
      checkedVersion: '0.64.0',
      localCompletedAt: 10,
      syncCompletedAt: 11,
    });
  });

  it('arms a blocked writer generation before a runtime canonical namespace downgrade', async () => {
    checkpoint('ready');
    const stored = JSON.parse(localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) ?? '{}');
    stored.servers['music.test'].checkedVersion = '0.64.0';
    localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify(stored));
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_begin') return beginResult(11);
      if (command === 'library_migration_abort') return undefined;
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(observeNavidromeCanonicalSuccessfulPing({
      profile: {
        id: 'profile', name: 'Music', url: 'https://music.test', username: 'user', password: 'password',
      },
      ping: { type: 'navidrome', serverVersion: '0.63.2' },
    })).resolves.toBe(true);

    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_abort', {
      generation: 11,
      serverId: 'music.test',
      error: expect.stringContaining('cannot be downgraded after 0.64.0'),
    });
    const next = JSON.parse(localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) ?? '{}');
    expect(next.servers['music.test']).toMatchObject({
      phase: 'blocked', sourceVersion: '0.63.2', checkedVersion: '0.64.0',
    });
  });

  it('serializes runtime observations so different server checkpoints cannot overwrite each other', async () => {
    const auth = JSON.parse(localStorage.getItem('psysonic-auth') ?? '{}');
    auth.state.servers.push({
      id: 'other-profile', name: 'Other', url: 'https://other.test', username: 'other', password: 'password',
    });
    localStorage.setItem('psysonic-auth', JSON.stringify(auth));

    await Promise.all([
      observeNavidromeCanonicalSuccessfulPing({
        profile: auth.state.servers[0],
        ping: { type: 'navidrome', serverVersion: '0.63.2' },
      }),
      observeNavidromeCanonicalSuccessfulPing({
        profile: auth.state.servers[1],
        ping: { type: 'navidrome', serverVersion: '0.63.1' },
      }),
    ]);

    const stored = JSON.parse(localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) ?? '{}');
    expect(stored.servers['music.test']).toMatchObject({ phase: 'legacy', checkedVersion: '0.63.2' });
    expect(stored.servers['other.test']).toMatchObject({ phase: 'legacy', checkedVersion: '0.63.1' });
  });

  it('finishes a generation admission when its profile is removed during begin', async () => {
    let resolveBegin!: (result: ReturnType<typeof beginResult>) => void;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_begin') {
        return new Promise<ReturnType<typeof beginResult>>(resolve => { resolveBegin = resolve; });
      }
      if (command === 'library_migration_finish_server' || command === 'library_migration_release') {
        return undefined;
      }
      throw new Error(`Unexpected command ${command}`);
    });

    const observation = observeNavidromeCanonicalSuccessfulPing({
      profile: {
        id: 'profile', name: 'Music', url: 'https://music.test', username: 'user', password: 'password',
      },
      ping: { type: 'navidrome', serverVersion: '0.64.0' },
    });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      'library_migration_begin',
      { serverIds: ['music.test'] },
    ));
    localStorage.removeItem('psysonic-auth');
    resolveBegin(beginResult(13));

    await expect(observation).rejects.toThrow('admission became stale');
    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_finish_server', {
      generation: 13,
      serverId: 'music.test',
      phase: 'not-applicable',
    });
    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_release', { generation: 13 });
    expect(localStorage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY)).toBeNull();
    expect(localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY)).toBeNull();
  });

  it('clears a runtime bootstrap lock when admission fails without an active generation', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_begin') throw new Error('activation failed');
      if (command === 'library_migration_inspect') return { state: 'inactive', lastGeneration: 7 };
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(observeNavidromeCanonicalSuccessfulPing({
      profile: {
        id: 'profile', name: 'Music', url: 'https://music.test', username: 'user', password: 'password',
      },
      ping: { type: 'navidrome', serverVersion: '0.64.0' },
    })).rejects.toThrow('activation failed');

    expect(localStorage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY)).toBeNull();
  });

  it('does not clear a bootstrap lock replaced by another operation after admission failure', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_begin') throw new Error('activation failed');
      if (command === 'library_migration_inspect') {
        localStorage.setItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY, '1');
        return { state: 'inactive', lastGeneration: 7 };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(observeNavidromeCanonicalSuccessfulPing({
      profile: {
        id: 'profile', name: 'Music', url: 'https://music.test', username: 'user', password: 'password',
      },
      ping: { type: 'navidrome', serverVersion: '0.64.0' },
    })).rejects.toThrow('activation failed');

    expect(localStorage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY)).toBe('1');
  });

  it('does not release a shared generation when a newly added admission becomes stale', async () => {
    let resolveBegin!: (result: ReturnType<typeof beginResult>) => void;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_begin') {
        return new Promise<ReturnType<typeof beginResult>>(resolve => { resolveBegin = resolve; });
      }
      if (command === 'library_migration_finish_server') return undefined;
      throw new Error(`Unexpected command ${command}`);
    });

    const observation = observeNavidromeCanonicalSuccessfulPing({
      profile: {
        id: 'profile', name: 'Music', url: 'https://music.test', username: 'user', password: 'password',
      },
      ping: { type: 'navidrome', serverVersion: '0.64.0' },
    });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      'library_migration_begin',
      { serverIds: ['music.test'] },
    ));
    localStorage.removeItem('psysonic-auth');
    resolveBegin(beginResult(20, false));

    await expect(observation).rejects.toThrow('admission became stale');
    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_finish_server', {
      generation: 20,
      serverId: 'music.test',
      phase: 'not-applicable',
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith('library_migration_release', expect.anything());
  });

  it('leaves an existing non-terminal server admission untouched when observation becomes stale', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_begin') {
        localStorage.removeItem('psysonic-auth');
        return beginResult(21, false, 'native');
      }
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(observeNavidromeCanonicalSuccessfulPing({
      profile: {
        id: 'profile', name: 'Music', url: 'https://music.test', username: 'user', password: 'password',
      },
      ping: { type: 'navidrome', serverVersion: '0.64.0' },
    })).rejects.toThrow('admission became stale');

    expect(mocks.invoke).not.toHaveBeenCalledWith('library_migration_finish_server', expect.anything());
    expect(mocks.invoke).not.toHaveBeenCalledWith('library_migration_release', expect.anything());
  });

  it('restores a terminal server phase without releasing its shared generation', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_begin') {
        localStorage.removeItem('psysonic-auth');
        return beginResult(22, false, 'ready');
      }
      if (command === 'library_migration_finish_server') return undefined;
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(observeNavidromeCanonicalSuccessfulPing({
      profile: {
        id: 'profile', name: 'Music', url: 'https://music.test', username: 'user', password: 'password',
      },
      ping: { type: 'navidrome', serverVersion: '0.64.0' },
    })).rejects.toThrow('admission became stale');

    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_finish_server', {
      generation: 22,
      serverId: 'music.test',
      phase: 'ready',
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith('library_migration_release', expect.anything());
  });

  it('releases a runtime version gate without full sync when the minimal-root inventory is clean', async () => {
    checkpoint('pending');
    const stored = JSON.parse(localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) ?? '{}');
    stored.servers['music.test'].sourceVersion = '0.65.0';
    stored.servers['music.test'].checkedVersion = '0.64.0';
    stored.servers['music.test'].localCompletedAt = 10;
    stored.servers['music.test'].syncCompletedAt = 11;
    localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify(stored));
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_inspect') {
        return { state: 'active', generation: 9, servers: [{ serverId: 'music.test', phase: 'pending' }] };
      }
      if (command === 'probe_server_connection') {
        return { ok: true, type: 'navidrome', serverVersion: '0.65.0', openSubsonic: true };
      }
      if (['library_migration_inventory', 'library_migration_finish_server', 'library_migration_release'].includes(command)) {
        return undefined;
      }
      throw new Error(`Unexpected command ${command}`);
    });

    await expect(runNavidromeCanonicalMigrationCoordinator({ windowKind: 'main' }))
      .resolves.toEqual({ blocked: false, migratedServers: 0 });
    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_finish_server', {
      generation: 9, serverId: 'music.test', phase: 'ready',
    });
    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_release', { generation: 9 });
    expect(mocks.invoke).not.toHaveBeenCalledWith('library_migration_sync_start', expect.anything());
    const next = JSON.parse(localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) ?? '{}');
    expect(next.servers['music.test']).toMatchObject({
      phase: 'ready', sourceVersion: '0.65.0', checkedVersion: '0.65.0',
    });
  });

  it('runs all durable phases, full sync, final verification, and release', async () => {
    localStorage.setItem('psysonic_device_sync', JSON.stringify({
      state: {
        targetDir: '/media/device',
        sources: [{
          type: 'album', id: '0000000000000000000001', name: 'Album', serverIndexKey: 'music.test',
        }],
      },
      version: 2,
    }));
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'library_migration_inspect') return { state: 'inactive', lastGeneration: 0 };
      if (command === 'probe_server_connection') {
        return { ok: true, type: 'navidrome', serverVersion: '0.64.0', openSubsonic: true };
      }
      if (command === 'library_migration_begin') return beginResult(7);
      if (command.endsWith('_upper_rowid')) return 0;
      if (command === 'library_migration_sync_start') {
        queueMicrotask(() => mocks.idleHandler?.({
          payload: {
            serverId: 'music.test', libraryScope: '', kind: 'initial_sync', source: 'foreground',
            jobId: 'job-1', ok: true, error: null,
          },
        }));
        return { jobId: 'job-1', serverId: 'music.test', kind: 'initial_sync' };
      }
      if (command === 'library_migration_finish_server') {
        expect(args).toMatchObject({ generation: 7, serverId: 'music.test', phase: 'ready' });
      }
      return undefined;
    });

    await expect(runNavidromeCanonicalMigrationCoordinator({ windowKind: 'main' }))
      .resolves.toEqual({ blocked: false, migratedServers: 1 });

    const commands = mocks.invoke.mock.calls.map(([command]) => command);
    expect(commands).toContain('library_migration_native_preflight');
    expect(commands).toContain('library_migration_native_finalize');
    expect(commands).toContain('library_migration_analysis_finalize');
    expect(commands).toContain('migrate_navidrome_filesystem_ids');
    expect(commands).toContain('cover_cache_migrate_navidrome_ids');
    expect(mocks.invoke).toHaveBeenCalledWith('library_migration_write_device_manifest', {
      generation: 7,
      serverId: 'music.test',
      destDir: '/media/device',
      sources: [{
        type: 'album', id: '0000000000000000000001', name: 'Album', serverIndexKey: 'music.test',
      }],
    });
    expect(commands).toContain('library_migration_sync_start');
    expect(commands.filter(command => command === 'library_migration_verify')).toHaveLength(2);
    const releaseIndex = commands.indexOf('library_migration_release');
    expect(mocks.invoke.mock.invocationCallOrder[releaseIndex])
      .toBeLessThan(mocks.commitImportedBackupRecovery.mock.invocationCallOrder[0]);
    expect(commands.indexOf('migrate_navidrome_filesystem_ids'))
      .toBeLessThan(commands.indexOf('library_migration_native_preflight'));
    expect(mocks.rewriteFrontend).toHaveBeenCalledOnce();
    expect(mocks.invalidateLyrics).toHaveBeenCalledWith(['music.test', 'profile']);

    const stored = JSON.parse(localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) ?? '{}');
    expect(stored.servers['music.test']).toMatchObject({
      sourceVersion: '0.64.0',
      checkedVersion: '0.64.0',
      phase: 'ready',
      step: null,
      lastError: null,
    });
    expect(stored.servers['music.test'].localCompletedAt).toBeTypeOf('number');
    expect(stored.servers['music.test'].syncCompletedAt).toBeTypeOf('number');
  });

  it('resumes from the saved analysis phase without replaying native finalization', async () => {
    checkpoint('analysis');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'library_migration_inspect') return { state: 'inactive', lastGeneration: 0 };
      if (command === 'probe_server_connection') {
        return { ok: true, type: 'navidrome', serverVersion: '0.64.0', openSubsonic: true };
      }
      if (command === 'library_migration_begin') return beginResult(8);
      if (command.endsWith('_upper_rowid')) return 0;
      if (command === 'library_migration_sync_start') {
        queueMicrotask(() => mocks.idleHandler?.({
          payload: {
            serverId: 'music.test', libraryScope: '', kind: 'initial_sync', source: 'foreground',
            jobId: 'job-2', ok: true,
          },
        }));
        return { jobId: 'job-2', serverId: 'music.test', kind: 'initial_sync' };
      }
      return undefined;
    });

    await runNavidromeCanonicalMigrationCoordinator({ windowKind: 'main' });
    const commands = mocks.invoke.mock.calls.map(([command]) => command);
    expect(commands).not.toContain('library_migration_native_preflight');
    expect(commands).not.toContain('library_migration_native_finalize');
    expect(commands).toContain('library_migration_analysis_finalize');
  });
});
