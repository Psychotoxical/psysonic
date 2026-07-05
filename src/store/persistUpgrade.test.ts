import { beforeEach, describe, expect, it } from 'vitest';
import { useAnalysisStrategyStore } from './analysisStrategyStore';
import { useLocalPlaybackStore } from './localPlaybackStore';
import { useOfflineStore } from '@/features/offline/store/offlineStore';

// Persist keys are byte-identical base↔branch (review §1), so the risk these guard
// is SHAPE drift when an old on-disk blob rehydrates into the current store — the
// silent data-loss vector in a store-moving refactor.

beforeEach(() => {
  localStorage.clear();
});

describe('analysisStrategyStore persist migrate (v0 → v1)', () => {
  it('upgrades a pre-version blob: preserves strategy, clamps parallelism, adds per-server maps', async () => {
    // A v0 blob predates the per-server override maps and never clamped stored values.
    localStorage.setItem(
      'psysonic-analytics-strategy',
      JSON.stringify({ state: { strategy: 'advanced', advancedParallelism: 50 }, version: 0 }),
    );
    await useAnalysisStrategyStore.persist.rehydrate();
    const s = useAnalysisStrategyStore.getState();
    expect(s.strategy).toBe('advanced'); // preserved (not the 'lazy' default)
    expect(s.advancedParallelism).toBe(20); // clamped to the [1, 20] max
    expect(s.strategyByServer).toEqual({}); // added by the migrate
    expect(s.advancedParallelismByServer).toEqual({}); // added by the migrate
  });

  it('passes a current (v1) blob through with its per-server maps intact', async () => {
    localStorage.setItem(
      'psysonic-analytics-strategy',
      JSON.stringify({
        state: {
          strategy: 'lazy',
          advancedParallelism: 4,
          strategyByServer: { s1: 'advanced' },
          advancedParallelismByServer: { s1: 3 },
        },
        version: 1,
      }),
    );
    await useAnalysisStrategyStore.persist.rehydrate();
    const s = useAnalysisStrategyStore.getState();
    expect(s.strategyByServer).toEqual({ s1: 'advanced' });
    expect(s.advancedParallelismByServer).toEqual({ s1: 3 });
  });
});

describe('localPlaybackStore rehydrate (partialize: entries)', () => {
  it('restores persisted entries on cold start', async () => {
    // Write through the real persist path, then simulate a cold start and rehydrate.
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'k',
      trackId: 't1',
      localPath: '/disk/t1.opus',
      layoutFingerprint: 'fp',
      sizeBytes: 1,
      suffix: 'opus',
      tier: 'library',
    });
    const persisted = localStorage.getItem('psysonic-local-playback');
    expect(persisted).toBeTruthy();

    useLocalPlaybackStore.setState({ entries: {} }); // cold start (also re-persists empty)
    localStorage.setItem('psysonic-local-playback', persisted!); // restore the on-disk blob
    expect(useLocalPlaybackStore.getState().getEntry('t1', 'k')).toBeNull();

    await useLocalPlaybackStore.persist.rehydrate();
    expect(useLocalPlaybackStore.getState().getEntry('t1', 'k')?.localPath).toBe('/disk/t1.opus');
  });
});

describe('offlineStore rehydrate (partialize: albums)', () => {
  it('restores persisted albums on cold start', async () => {
    const albums = { 's1:alb1': { id: 'alb1', name: 'X', artist: 'Y', tracks: [] } };
    useOfflineStore.setState({ albums: {} }); // clean baseline (re-persists empty)
    localStorage.setItem('psysonic-offline', JSON.stringify({ state: { albums }, version: 0 }));
    await useOfflineStore.persist.rehydrate();
    expect(useOfflineStore.getState().albums).toEqual(albums);
  });
});
