import { beforeEach, describe, expect, it } from 'vitest';
import {
  deviceSyncOwnerKey,
  deviceSyncSourceKey,
  deviceSyncSourcesFromManifest,
  migrateDeviceSyncPersistedState,
  useDeviceSyncStore,
  type DeviceSyncSource,
} from './deviceSyncStore';
import { activateCanonicalNavidromeOwners } from '@/lib/server/navidromeCanonicalIds';

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

  it('preserves ownerless v0 selections until a server is explicitly selected', () => {
    const legacy = {
      type: 'album' as const,
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      name: 'Legacy',
    };
    const migrated = migrateDeviceSyncPersistedState({ sources: [legacy] });
    expect(migrated.sources).toEqual([]);
    expect(migrated.legacySources).toEqual([legacy]);

    useDeviceSyncStore.setState(migrated);
    activateCanonicalNavidromeOwners([sourceA.serverIndexKey]);
    useDeviceSyncStore.getState().addSource(sourceA);

    expect(useDeviceSyncStore.getState().legacySources).toEqual([]);
    expect(useDeviceSyncStore.getState().sources).toEqual([
      { ...legacy, id: '7rke2SAWaicSeSYzkhww6R', serverIndexKey: sourceA.serverIndexKey },
      sourceA,
    ]);
  });
});
