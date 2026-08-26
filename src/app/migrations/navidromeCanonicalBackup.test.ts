import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import {
  NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
  NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY,
} from './navidromeCanonicalCheckpoint';
import {
  armNavidromeCanonicalBackupImport,
  disarmNavidromeCanonicalBackupImport,
  normalizeNavidromeCanonicalBackupStores,
  prepareNavidromeCanonicalDatabaseImport,
} from './navidromeCanonicalBackup';

const LEGACY_ID = '123e4567-e89b-12d3-a456-426614174000';

function seedReadyCheckpoint(): void {
  localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify({
    version: 1,
    servers: {
      'music.test': {
        sourceVersion: '0.64.0',
        checkedVersion: '0.64.0',
        canonicalVersion: 1,
        phase: 'ready',
        step: null,
        cursorRowid: 0,
        upperRowid: 0,
        cursorKey: null,
        upperKey: null,
        startedAt: 1,
        updatedAt: 1,
        localCompletedAt: 1,
        syncCompletedAt: 1,
        lastError: null,
      },
    },
  }));
}

function importedAuth(): Record<string, unknown> {
  return {
    state: {
      servers: [{
        id: 'profile', name: 'Music', url: 'https://music.test', username: 'user', password: 'password',
      }],
      activeServerId: 'profile',
      musicFoldersByServer: {
        'music.test': [{ id: LEGACY_ID, name: 'Library' }],
      },
    },
    version: 1,
  };
}

describe('normalizeNavidromeCanonicalBackupStores', () => {
  beforeEach(() => {
    localStorage.clear();
    seedReadyCheckpoint();
  });

  it('normalizes staged identity stores after backup activation is armed', () => {
    armNavidromeCanonicalBackupImport();
    const stores = normalizeNavidromeCanonicalBackupStores({
      'psysonic-auth': importedAuth(),
      'psysonic-player': {
        state: {
          queueServerId: 'profile',
          currentTrack: { id: LEGACY_ID, serverId: 'profile' },
          queueItems: [{ serverId: 'profile', trackId: LEGACY_ID }],
          queueRefs: [LEGACY_ID],
          queue: [{ id: LEGACY_ID }],
        },
        version: 1,
      },
    });

    const canonical = canonicalNavidromeId(LEGACY_ID);
    expect(stores['psysonic-auth']).toMatchObject({
      state: { musicFoldersByServer: { 'music.test': [{ id: canonical }] } },
    });
    expect(stores['psysonic-player']).toMatchObject({
      state: {
        currentTrack: { id: canonical },
        queueItems: [{ trackId: canonical }],
        queueRefs: [canonical],
        queue: [{ id: canonical }],
      },
    });
    expect(localStorage.getItem('psysonic-auth')).toBeNull();
    expect(localStorage.getItem('psysonic-player')).toBeNull();
    expect(localStorage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY)).toBe('1');
  });

  it('can disarm activation when staged identity state is malformed', () => {
    armNavidromeCanonicalBackupImport();
    expect(() => normalizeNavidromeCanonicalBackupStores({
      'psysonic-auth': importedAuth(),
      'psysonic-player': 'malformed',
    })).toThrow('Malformed persisted state in psysonic-player');
    expect(localStorage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY)).toBe('1');
    disarmNavidromeCanonicalBackupImport();
    expect(localStorage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY)).toBeNull();
  });

  it('removes stale ready checkpoints before database activation and can restore them', () => {
    const previous = localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY);
    const plan = prepareNavidromeCanonicalDatabaseImport();

    expect(plan.serverIds).toEqual([]);
    expect(plan.canonicalServerIds).toEqual(['music.test']);
    expect(JSON.parse(
      localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) ?? '{}',
    )).toEqual({ version: 1, servers: {} });

    plan.rollbackCheckpoint();
    expect(localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY)).toBe(previous);
  });

  it('arms imported profiles as pending before their database becomes active', () => {
    const plan = prepareNavidromeCanonicalDatabaseImport({
      'psysonic-auth': importedAuth(),
    });

    expect(plan.serverIds).toEqual(['music.test']);
    expect(JSON.parse(
      localStorage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) ?? '{}',
    ).servers['music.test']).toMatchObject({
      phase: 'pending',
      step: 'backup-import',
      checkedVersion: null,
    });
  });
});
