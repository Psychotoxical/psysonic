import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const starMock = vi.fn();
const unstarMock = vi.fn();
const setRatingMock = vi.fn();
vi.mock('@/lib/api/subsonicStarRating', () => ({
  star: (...a: unknown[]) => starMock(...a),
  unstar: (...a: unknown[]) => unstarMock(...a),
  setRating: (...a: unknown[]) => setRatingMock(...a),
}));

import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { Track } from '@/lib/media/trackTypes';
import {
  resetActiveServerConnectionSnapshot,
  setActiveServerReachable,
} from '@/lib/network/activeServerReachability';
import { queueSongStar, queueSongRating, _resetPendingStarSyncForTest } from '@/features/playback/store/pendingStarSync';
import {
  getCachedTrack,
  seedQueueResolver,
  _resetQueueResolverForTest,
} from '@/features/playback/store/queueTrackResolver';
import { toQueueItemRefs } from '@/features/playback/store/queueItemRef';

const track = (id: string): Track => ({
  id, title: id, artist: '', album: 'A', albumId: 'A', duration: 1,
});

describe('pendingStarSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetActiveServerConnectionSnapshot();
    setActiveServerReachable(true);
    starMock.mockReset().mockResolvedValue(undefined);
    unstarMock.mockReset().mockResolvedValue(undefined);
    setRatingMock.mockReset().mockResolvedValue(undefined);
    _resetPendingStarSyncForTest();
    _resetQueueResolverForTest();
    // Thin-state: the queue's track copy lives in the resolver cache. Seed it so
    // a star/rating success has a cached entry to patch in place.
    seedQueueResolver('', [track('t1')]);
    usePlayerStore.setState({
      currentTrack: track('t1'),
      queueItems: toQueueItemRefs('', [track('t1')]),
      queueServerId: null,
      starredOverrides: {},
      userRatingOverrides: {},
    });
  });
  afterEach(() => {
    _resetPendingStarSyncForTest();
    vi.useRealTimers();
  });

  it('stars optimistically, then keeps the override + patches the track on success', async () => {
    queueSongStar('t1', true);
    expect(usePlayerStore.getState().starredOverrides.t1).toBe(true); // optimistic, instant

    await vi.runAllTimersAsync();

    expect(starMock).toHaveBeenCalledWith('t1', 'song', undefined);
    const s = usePlayerStore.getState();
    expect(s.starredOverrides.t1).toBe(true); // kept on success so list views stay in sync
    expect(s.currentTrack?.starred).toBeTruthy(); // in-memory track patched
    // Thin-state: the resolver cache entry is patched in place (not dropped) so
    // the visible queue row keeps its title and reflects the synced star —
    // dropping it would blank the row to a "…" placeholder.
    const cached = getCachedTrack({ serverId: '', trackId: 't1' });
    expect(cached?.title).toBe('t1');
    expect(cached?.starred).toBeTruthy();
  });

  it('does NOT roll back on a network failure and keeps retrying', async () => {
    starMock.mockRejectedValue(new Error('offline'));
    queueSongStar('t1', true);

    await vi.advanceTimersByTimeAsync(4000); // 0ms + 1s + 2s backoff cycles

    expect(starMock.mock.calls.length).toBeGreaterThanOrEqual(2); // retried
    expect(usePlayerStore.getState().starredOverrides.t1).toBe(true); // override survives (no rollback)
  });

  it('flushes pending stars when the active server becomes reachable', async () => {
    starMock.mockRejectedValue(new Error('offline'));
    queueSongStar('t1', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(starMock).toHaveBeenCalledTimes(1);

    setActiveServerReachable(false);
    setActiveServerReachable(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(starMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('passes serverId through to star/unstar for cross-server favorites', async () => {
    queueSongStar('t1', true, 'srv-b');
    await vi.runAllTimersAsync();
    expect(starMock).toHaveBeenCalledWith('t1', 'song', { serverId: 'srv-b' });
  });

  it('latest toggle wins when re-queued before sync', async () => {
    queueSongStar('t1', true);
    queueSongStar('t1', false); // user toggled back off
    await vi.runAllTimersAsync();
    expect(unstarMock).toHaveBeenCalledWith('t1', 'song', undefined);
    expect(usePlayerStore.getState().starredOverrides.t1).toBe(false); // kept as durable false
    expect(usePlayerStore.getState().currentTrack?.starred).toBeFalsy();
  });

  it('rates optimistically (track patched), clears override on success', async () => {
    queueSongRating('t1', 4);
    // setUserRatingOverride patches the track immediately:
    expect(usePlayerStore.getState().currentTrack?.userRating).toBe(4);
    expect(usePlayerStore.getState().userRatingOverrides.t1).toBe(4);

    await vi.runAllTimersAsync();

    expect(setRatingMock).toHaveBeenCalledWith('t1', 4);
    const s = usePlayerStore.getState();
    expect('t1' in s.userRatingOverrides).toBe(false); // cleared
    expect(s.currentTrack?.userRating).toBe(4); // track stays patched
  });
});
