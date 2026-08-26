import { beforeEach, describe, expect, it } from 'vitest';
import {
  deviceSyncOwnerKey,
  deviceSyncSourceKey,
  deviceSyncSourcesFromManifest,
  migrateDeviceSyncPersistedState,
  useDeviceSyncStore,
  type DeviceSyncSource,
} from './deviceSyncStore';
import { canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import { NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY } from '@/lib/server/navidromeCanonicalCheckpointStatus';

const sourceA: DeviceSyncSource = {
  type: 'album',
  id: 'shared-id',
  name: 'Album A',
  serverIndexKey: 'server-a.test',
};

const sourceB: DeviceSyncSource = {
  ...sourceA,
  name: 'Album B',
  serverIndexKey: 'server-b.test',
};

describe('deviceSyncStore ownership', () => {
  beforeEach(() => {
    localStorage.clear();
    useDeviceSyncStore.setState({
      targetDir: null,
      sources: [],
      legacySources: [],
      checkedIds: [],
      pendingDeletion: [],
      deviceFilePaths: [],
      scanning: false,
    });
  });

  it('qualifies colliding raw IDs by server and source type', () => {
    expect(deviceSyncSourceKey(sourceA)).not.toBe(deviceSyncSourceKey(sourceB));
    expect(deviceSyncSourceKey(sourceA)).not.toBe(deviceSyncSourceKey({
      ...sourceA,
      type: 'playlist',
    }));
  });

  it('keeps one durable owner per device configuration', () => {
    useDeviceSyncStore.getState().addSource(sourceA);
    useDeviceSyncStore.getState().addSource(sourceB);

    expect(useDeviceSyncStore.getState().sources).toEqual([sourceA]);
    expect(deviceSyncOwnerKey(useDeviceSyncStore.getState().sources)).toBe(sourceA.serverIndexKey);
  });

  it('imports only owner-qualified manifests with a matching manifest owner', () => {
    expect(deviceSyncSourcesFromManifest({
      version: 3,
      ownerServerIndexKey: sourceA.serverIndexKey,
      sources: [sourceA],
    })).toEqual([sourceA]);

    expect(deviceSyncSourcesFromManifest({
      version: 2,
      sources: [{ type: 'album', id: 'legacy', name: 'Legacy' }],
    })).toEqual([]);

    expect(deviceSyncSourcesFromManifest({
      version: 2,
      sources: [{ type: 'album', id: 'legacy', name: 'Legacy' }],
    }, sourceA.serverIndexKey)).toEqual([{
      type: 'album',
      id: 'legacy',
      name: 'Legacy',
      serverIndexKey: sourceA.serverIndexKey,
    }]);

    expect(deviceSyncSourcesFromManifest({
      version: 3,
      ownerServerIndexKey: sourceB.serverIndexKey,
      sources: [sourceA],
    })).toEqual([]);
  });

  it('preserves ownerless v0 selections until explicit recovery or discard', () => {
    const legacy = { type: 'album' as const, id: 'legacy', name: 'Legacy' };
    const migrated = migrateDeviceSyncPersistedState({ sources: [legacy] });
    expect(migrated.sources).toEqual([]);
    expect(migrated.legacySources).toEqual([legacy]);

    useDeviceSyncStore.setState(migrated);
    useDeviceSyncStore.getState().addSource(sourceA);

    expect(useDeviceSyncStore.getState().legacySources).toEqual([legacy]);
    expect(useDeviceSyncStore.getState().sources).toEqual([sourceA]);

    useDeviceSyncStore.getState().clearSources();
    expect(useDeviceSyncStore.getState().legacySources).toEqual([legacy]);
  });

  it('canonicalizes old manifest source IDs when the owner checkpoint is ready', () => {
    const legacyId = '123e4567-e89b-12d3-a456-426614174000';
    localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify({
      version: 1,
      servers: {
        [sourceA.serverIndexKey]: {
          canonicalVersion: 1,
          phase: 'ready',
          checkedVersion: '0.64.0',
        },
      },
    }));

    expect(deviceSyncSourcesFromManifest({
      version: 2,
      sources: [{ type: 'album', id: legacyId, name: 'Legacy' }],
    }, sourceA.serverIndexKey)).toEqual([{
      type: 'album',
      id: canonicalNavidromeId(legacyId),
      name: 'Legacy',
      serverIndexKey: sourceA.serverIndexKey,
    }]);
  });

  it('defers old manifest import while the owner canonical migration is pending', () => {
    localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify({
      version: 1,
      servers: {
        [sourceA.serverIndexKey]: {
          canonicalVersion: 1,
          phase: 'frontend',
          checkedVersion: null,
        },
      },
    }));

    expect(deviceSyncSourcesFromManifest({
      version: 2,
      sources: [{ type: 'album', id: 'legacy', name: 'Legacy' }],
    }, sourceA.serverIndexKey)).toEqual([]);
  });
});
