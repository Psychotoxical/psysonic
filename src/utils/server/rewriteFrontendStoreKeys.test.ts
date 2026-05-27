import { beforeEach, describe, expect, it } from 'vitest';
import { useAnalysisStrategyStore } from '../../store/analysisStrategyStore';
import { useCoverStrategyStore } from '../../store/coverStrategyStore';
import { useHotCacheStore } from '../../store/hotCacheStore';
import { useOfflineStore } from '../../store/offlineStore';
import { usePlayerStore } from '../../store/playerStore';
import { rewriteFrontendStoreKeysForRemap } from './rewriteFrontendStoreKeys';

describe('rewriteFrontendStoreKeysForRemap', () => {
  beforeEach(() => {
    useOfflineStore.setState({ tracks: {}, albums: {} });
    useHotCacheStore.setState({ entries: {} });
    useAnalysisStrategyStore.setState({
      strategyByServer: {},
      advancedParallelismByServer: {},
    });
    useCoverStrategyStore.setState({ strategyByServer: {} });
    usePlayerStore.setState({ queueServerId: null });
  });

  it('no-ops on empty remap list', async () => {
    useOfflineStore.setState({
      tracks: { 'old:t1': { serverId: 'old' } as never },
      albums: {},
    });
    await rewriteFrontendStoreKeysForRemap([]);
    expect(useOfflineStore.getState().tracks).toHaveProperty('old:t1');
  });

  it('no-ops when oldKey === newKey', async () => {
    useOfflineStore.setState({
      tracks: { 'same:t1': { serverId: 'same' } as never },
      albums: {},
    });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'same', newKey: 'same' }]);
    expect(useOfflineStore.getState().tracks).toHaveProperty('same:t1');
  });

  it('rewrites offline tracks + albums under the new key', async () => {
    useOfflineStore.setState({
      tracks: { 'old:t1': { serverId: 'old' } as never },
      albums: { 'old:al-1': { serverId: 'old' } as never },
    });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);
    const state = useOfflineStore.getState();
    expect(state.tracks).toHaveProperty('new:t1');
    expect(state.tracks).not.toHaveProperty('old:t1');
    expect(state.albums).toHaveProperty('new:al-1');
    expect(state.albums).not.toHaveProperty('old:al-1');
  });

  it('rewrites hot-cache entries under the new key', async () => {
    useHotCacheStore.setState({
      entries: { 'old:t1': { trackId: 't1' } as never },
    });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);
    const entries = useHotCacheStore.getState().entries;
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

  it('leaves queueServerId untouched when it is bound to a different server', async () => {
    usePlayerStore.setState({ queueServerId: 'other' });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);
    expect(usePlayerStore.getState().queueServerId).toBe('other');
  });

  it('does not clobber an existing entry under the new key', async () => {
    useOfflineStore.setState({
      tracks: {
        'old:t1': { serverId: 'old', tag: 'from-old' } as never,
        'new:t1': { serverId: 'new', tag: 'from-new' } as never,
      },
      albums: {},
    });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);
    const tracks = useOfflineStore.getState().tracks as unknown as Record<string, { tag: string }>;
    // Existing destination preserved — same prefer-existing semantics as
    // the disk-side cover bucket merge.
    expect(tracks['new:t1']?.tag).toBe('from-new');
    expect(tracks).not.toHaveProperty('old:t1');
  });
});
