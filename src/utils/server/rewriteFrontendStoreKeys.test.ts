import { beforeEach, describe, expect, it } from 'vitest';
import { useAnalysisStrategyStore } from '../../store/analysisStrategyStore';
import { useCoverStrategyStore } from '../../store/coverStrategyStore';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import { useOfflineStore } from '@/features/offline';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { rewriteFrontendStoreKeysForRemap } from './rewriteFrontendStoreKeys';

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

  it('rewrites offline albums under the new key', async () => {
    useOfflineStore.setState({
      albums: { 'old:al-1': { serverId: 'old', id: 'al-1', name: 'X', artist: 'Y', trackIds: [] } },
    });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);
    const state = useOfflineStore.getState();
    expect(state.albums).toHaveProperty('new:al-1');
    expect(state.albums).not.toHaveProperty('old:al-1');
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
});
