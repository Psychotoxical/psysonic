import { beforeEach, describe, expect, it } from 'vitest';
import { useAnalysisStrategyStore } from '../../store/analysisStrategyStore';
import { useCoverStrategyStore } from '../../store/coverStrategyStore';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import { useOfflineStore } from '@/features/offline';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { deviceSyncSourceKey, useDeviceSyncStore } from '@/features/deviceSync';
import {
  rewriteFrontendStoreKeys,
  rewriteFrontendStoreKeysForRemap,
} from './rewriteFrontendStoreKeys';
import { makeServer } from '@/test/helpers/factories';
import {
  beginOfflineTrackTransfer,
  runOfflineServerMaintenanceBatch,
} from '@/features/offline/utils/offlineOperationCoordinator';

describe('rewriteFrontendStoreKeysForRemap', () => {
  beforeEach(() => {
    useOfflineStore.setState({ albums: {} });
    useLocalPlaybackStore.setState({ entries: {} });
    useAnalysisStrategyStore.setState({
      strategyByServer: {},
      advancedParallelismByServer: {},
    });
    useCoverStrategyStore.setState({ strategyByServer: {} });
    usePlayerStore.setState({ queueServerId: null });
    useDeviceSyncStore.setState({ sources: [], checkedIds: [], pendingDeletion: [] });
  });

  it('no-ops on empty remap list', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'old:t1': {
          serverIndexKey: 'old',
          trackId: 't1',
          localPath: '/x',
          layoutFingerprint: '',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    await rewriteFrontendStoreKeysForRemap([]);
    expect(useLocalPlaybackStore.getState().entries).toHaveProperty('old:t1');
  });

  it('no-ops when oldKey === newKey', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'same:t1': {
          serverIndexKey: 'same',
          trackId: 't1',
          localPath: '/x',
          layoutFingerprint: '',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'same', newKey: 'same' }]);
    expect(useLocalPlaybackStore.getState().entries).toHaveProperty('same:t1');
  });

  it('waits for active offline operations before remapping keys', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'old:t1': {
          serverIndexKey: 'old',
          trackId: 't1',
          localPath: '/x',
          layoutFingerprint: '',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    const finishTransfer = await beginOfflineTrackTransfer('old', 't1');
    let rewriteFinished = false;
    const rewrite = runOfflineServerMaintenanceBatch(
      ['old', 'new'],
      () => rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]),
    ).then(() => {
      rewriteFinished = true;
    });
    await Promise.resolve();
    expect(rewriteFinished).toBe(false);

    finishTransfer();
    await rewrite;
    expect(useLocalPlaybackStore.getState().entries).not.toHaveProperty('old:t1');
    expect(useLocalPlaybackStore.getState().entries).toHaveProperty('new:t1');
  });

  it('rewrites offline albums under the new key', async () => {
    useOfflineStore.setState({
      albums: { 'old:al-1': { serverId: 'old', id: 'al-1', name: 'X', artist: 'Y', trackIds: [] } },
    });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);
    const state = useOfflineStore.getState();
    expect(state.albums).toHaveProperty('new:al-1');
    expect(state.albums).not.toHaveProperty('old:al-1');
  });

  it('matches the full server key when it contains a port', async () => {
    useOfflineStore.setState({
      albums: {
        'old.test:4533:al-1': {
          serverId: 'old.test:4533',
          id: 'al-1',
          name: 'X',
          artist: 'Y',
          trackIds: ['t1'],
        },
      },
    });

    await rewriteFrontendStoreKeysForRemap([
      { oldKey: 'old.test:4533', newKey: 'new.test:4533' },
    ]);

    expect(useOfflineStore.getState().albums).toEqual({
      'new.test:4533:al-1': expect.objectContaining({
        serverId: 'new.test:4533',
        id: 'al-1',
      }),
    });
  });

  it('merges offline album track IDs when the destination key already exists', async () => {
    useOfflineStore.setState({
      albums: {
        'old:al-1': {
          serverId: 'old', id: 'al-1', name: 'Old', artist: 'Artist', trackIds: ['t1', 't2'],
        },
        'new:al-1': {
          serverId: 'new', id: 'al-1', name: 'New', artist: 'Artist', trackIds: ['t2', 't3'],
        },
      },
    });

    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);

    expect(useOfflineStore.getState().albums['new:al-1']).toEqual(expect.objectContaining({
      serverId: 'new',
      name: 'New',
      trackIds: ['t2', 't3', 't1'],
    }));
    expect(useOfflineStore.getState().albums).not.toHaveProperty('old:al-1');
  });

  it('rewrites local playback entries under the new key', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'old:t1': {
          serverIndexKey: 'old',
          trackId: 't1',
          localPath: '/x',
          layoutFingerprint: '',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);
    const entries = useLocalPlaybackStore.getState().entries;
    expect(entries).toHaveProperty('new:t1');
    expect(entries).not.toHaveProperty('old:t1');
  });

  it('moves analysis strategy + advanced-parallelism entries to the new key', async () => {
    useAnalysisStrategyStore.setState({
      strategyByServer: { old: 'lazy' as never },
      advancedParallelismByServer: { old: 3 },
    });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);
    const s = useAnalysisStrategyStore.getState();
    expect(s.strategyByServer).toHaveProperty('new');
    expect(s.strategyByServer).not.toHaveProperty('old');
    expect(s.advancedParallelismByServer.new).toBe(3);
    expect(s.advancedParallelismByServer.old).toBeUndefined();
  });

  it('moves cover strategy entries to the new key', async () => {
    useCoverStrategyStore.setState({
      strategyByServer: { old: 'aggressive' as never },
    });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);
    const s = useCoverStrategyStore.getState();
    expect(s.strategyByServer).toHaveProperty('new');
    expect(s.strategyByServer).not.toHaveProperty('old');
  });

  it('repoints player queueServerId when it matches the old key', async () => {
    usePlayerStore.setState({ queueServerId: 'old' });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);
    expect(usePlayerStore.getState().queueServerId).toBe('new');
  });

  it('repoints queueItems serverId when refs match the old key', async () => {
    usePlayerStore.setState({
      queueServerId: 'old',
      queueItems: [
        { serverId: 'old', trackId: 't1' },
        { serverId: 'other', trackId: 't2' },
      ],
      queueIndex: 0,
    });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);
    const s = usePlayerStore.getState();
    expect(s.queueServerId).toBe('new');
    expect(s.queueItems[0]).toEqual({ serverId: 'new', trackId: 't1' });
    expect(s.queueItems[1]).toEqual({ serverId: 'other', trackId: 't2' });
  });

  it('repoints device-sync sources and staged composite identities', async () => {
    const source = { type: 'album' as const, id: 'album-1', name: 'Album', serverIndexKey: 'old' };
    const oldSourceKey = deviceSyncSourceKey(source);
    useDeviceSyncStore.setState({
      sources: [source],
      checkedIds: [oldSourceKey],
      pendingDeletion: [oldSourceKey],
    });

    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);

    const state = useDeviceSyncStore.getState();
    const newSourceKey = deviceSyncSourceKey({ ...source, serverIndexKey: 'new' });
    expect(state.sources[0]?.serverIndexKey).toBe('new');
    expect(state.checkedIds).toEqual([newSourceKey]);
    expect(state.pendingDeletion).toEqual([newSourceKey]);
  });

  it('leaves queueServerId untouched when it is bound to a different server', async () => {
    usePlayerStore.setState({ queueServerId: 'other' });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);
    expect(usePlayerStore.getState().queueServerId).toBe('other');
  });

  it('does not clobber an existing entry under the new key', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'old:t1': {
          serverIndexKey: 'old',
          trackId: 't1',
          localPath: '/old',
          layoutFingerprint: '',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'mp3',
        },
        'new:t1': {
          serverIndexKey: 'new',
          trackId: 't1',
          localPath: '/new',
          layoutFingerprint: '',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);
    const entries = useLocalPlaybackStore.getState().entries;
    expect(entries['new:t1']?.localPath).toBe('/new');
    expect(entries).not.toHaveProperty('old:t1');
  });

  it('keeps the more durable local playback tier on a key collision', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'old:t1': {
          serverIndexKey: 'old',
          trackId: 't1',
          localPath: '/old-library',
          layoutFingerprint: 'old',
          sizeBytes: 10,
          tier: 'library',
          cachedAt: 1,
          lastPlayedAt: 5,
          suffix: 'flac',
        },
        'new:t1': {
          serverIndexKey: 'new',
          trackId: 't1',
          localPath: '/new-cache',
          layoutFingerprint: 'new',
          sizeBytes: 5,
          tier: 'ephemeral',
          cachedAt: 2,
          lastPlayedAt: 10,
          suffix: 'mp3',
        },
      },
    });

    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);

    expect(useLocalPlaybackStore.getState().entries['new:t1']).toEqual(expect.objectContaining({
      serverIndexKey: 'new',
      localPath: '/old-library',
      tier: 'library',
      lastPlayedAt: 10,
    }));
    expect(useLocalPlaybackStore.getState().entries).not.toHaveProperty('old:t1');
  });

  it('merges UUID-keyed upgrade collisions that converge on one URL key', async () => {
    const serverA = makeServer({ id: 'profile-a', url: 'http://same.test:4533' });
    const serverB = makeServer({ id: 'profile-b', url: 'https://same.test:4533' });
    useOfflineStore.setState({
      albums: {
        'profile-a:al-1': {
          serverId: 'profile-a', id: 'al-1', name: 'Album', artist: 'Artist', trackIds: ['t1'],
        },
        'profile-b:al-1': {
          serverId: 'profile-b', id: 'al-1', name: 'Album', artist: 'Artist', trackIds: ['t2'],
        },
      },
    });
    useLocalPlaybackStore.setState({
      entries: {
        'profile-a:t1': {
          serverIndexKey: 'profile-a', trackId: 't1', localPath: '/library',
          layoutFingerprint: '', sizeBytes: 10, tier: 'library', cachedAt: 1, suffix: 'flac',
        },
        'profile-b:t1': {
          serverIndexKey: 'profile-b', trackId: 't1', localPath: '/cache',
          layoutFingerprint: '', sizeBytes: 5, tier: 'ephemeral', cachedAt: 2, suffix: 'mp3',
        },
      },
    });

    await rewriteFrontendStoreKeys([serverA, serverB]);

    expect(useOfflineStore.getState().albums['same.test:4533:al-1']?.trackIds)
      .toEqual(['t1', 't2']);
    expect(useLocalPlaybackStore.getState().entries['same.test:4533:t1'])
      .toEqual(expect.objectContaining({ localPath: '/library', tier: 'library' }));
  });
});
