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
import { useAuthStore } from '@/store/authStore';
import {
  activateCanonicalNavidromeOwners,
  canonicalizeNavidromeId,
  deactivateCanonicalNavidromeOwners,
} from '@/lib/server/navidromeCanonicalIds';

const track = (id: string): Track => ({
  id, title: id, artist: '', album: 'A', albumId: 'A', duration: 1,
});

describe('pendingStarSync', () => {
  beforeEach(() => {
    deactivateCanonicalNavidromeOwners(['srv-b']);
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
    useAuthStore.setState({ activeServerId: 'srv-a' });
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
    expect(usePlayerStore.getState().starredOverrides['srv-b:t1']).toBe(true);
    expect(usePlayerStore.getState().starredOverrides.t1).toBeUndefined();
    await vi.runAllTimersAsync();
    expect(starMock).toHaveBeenCalledWith('t1', 'song', { serverId: 'srv-b' });
  });

  it('keeps a random-song retry on its stamped owner after the active server changes', async () => {
    starMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    queueSongStar('shared', true, 'srv-b');
    await vi.advanceTimersByTimeAsync(0);

    useAuthStore.setState({ activeServerId: 'srv-c' });
    await vi.advanceTimersByTimeAsync(1000);

    expect(starMock).toHaveBeenNthCalledWith(1, 'shared', 'song', { serverId: 'srv-b' });
    expect(starMock).toHaveBeenNthCalledWith(2, 'shared', 'song', { serverId: 'srv-b' });
    expect(usePlayerStore.getState().starredOverrides).toEqual({
      'srv-b:shared': true,
    });
  });

  it('isolates scoped favorite overrides that share a raw id', async () => {
    queueSongStar('shared', false, 'srv-b', { scopedOverride: true });

    expect(usePlayerStore.getState().starredOverrides).toMatchObject({
      'srv-b:shared': false,
    });
    expect(usePlayerStore.getState().starredOverrides.shared).toBeUndefined();

    await vi.runAllTimersAsync();
    expect(unstarMock).toHaveBeenCalledWith('shared', 'song', { serverId: 'srv-b' });
  });

  it('latest toggle wins when re-queued before sync', async () => {
    queueSongStar('t1', true);
    queueSongStar('t1', false); // user toggled back off
    await vi.runAllTimersAsync();
    expect(unstarMock).toHaveBeenCalledWith('t1', 'song', undefined);
    expect(usePlayerStore.getState().starredOverrides.t1).toBe(false); // kept as durable false
    expect(usePlayerStore.getState().currentTrack?.starred).toBeFalsy();
  });

  it('serializes an in-flight star toggle so the latest request reaches the server last', async () => {
    let resolveFirst!: () => void;
    starMock.mockImplementationOnce(() => new Promise<void>(resolve => { resolveFirst = resolve; }));

    queueSongStar('t1', true);
    await vi.advanceTimersByTimeAsync(0);
    queueSongStar('t1', false);
    await vi.advanceTimersByTimeAsync(0);

    expect(starMock).toHaveBeenCalledTimes(1);
    expect(unstarMock).not.toHaveBeenCalled();

    resolveFirst();
    await vi.runAllTimersAsync();

    expect(unstarMock).toHaveBeenCalledWith('t1', 'song', undefined);
    expect(usePlayerStore.getState().starredOverrides.t1).toBe(false);
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

  it('routes scoped ratings to the owner and clears only its composite override', async () => {
    const ownedTrack = { ...track('shared'), serverId: 'srv-b' };
    seedQueueResolver('srv-b', [ownedTrack]);
    usePlayerStore.setState({ currentTrack: ownedTrack });
    queueSongRating('shared', 5, 'srv-b', { scopedOverride: true });
    expect(usePlayerStore.getState().userRatingOverrides['srv-b:shared']).toBe(5);
    expect(usePlayerStore.getState().userRatingOverrides.shared).toBeUndefined();
    expect(usePlayerStore.getState().currentTrack?.userRating).toBe(5);

    await vi.runAllTimersAsync();

    expect(setRatingMock).toHaveBeenCalledWith('shared', 5, { serverId: 'srv-b' });
    expect(usePlayerStore.getState().userRatingOverrides['srv-b:shared']).toBeUndefined();
  });

  it('serializes in-flight ratings so an older response cannot overwrite the latest value', async () => {
    let resolveFirst!: () => void;
    setRatingMock.mockImplementationOnce(() => new Promise<void>(resolve => { resolveFirst = resolve; }));

    queueSongRating('t1', 2);
    await vi.advanceTimersByTimeAsync(0);
    queueSongRating('t1', 5);
    await vi.advanceTimersByTimeAsync(0);

    expect(setRatingMock).toHaveBeenCalledTimes(1);

    resolveFirst();
    await vi.runAllTimersAsync();

    expect(setRatingMock).toHaveBeenNthCalledWith(2, 't1', 5);
    expect(usePlayerStore.getState().currentTrack?.userRating).toBe(5);
    expect(usePlayerStore.getState().userRatingOverrides.t1).toBeUndefined();
  });

  it('canonicalizes a deferred retry and its scoped override after owner activation', async () => {
    const legacyId = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
    const canonicalId = canonicalizeNavidromeId(legacyId);
    starMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);

    queueSongStar(legacyId, true, 'srv-b', { scopedOverride: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(starMock).toHaveBeenLastCalledWith(legacyId, 'song', { serverId: 'srv-b' });

    activateCanonicalNavidromeOwners(['srv-b']);
    await vi.advanceTimersByTimeAsync(1000);

    expect(starMock).toHaveBeenLastCalledWith(canonicalId, 'song', { serverId: 'srv-b' });
    expect(starMock).toHaveBeenCalledTimes(2);
    expect(usePlayerStore.getState().starredOverrides).toEqual({
      [`srv-b:${canonicalId}`]: true,
    });
  });

  it('drops a legacy retry when a newer canonical toggle supersedes it', async () => {
    const legacyId = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
    const canonicalId = canonicalizeNavidromeId(legacyId);
    starMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);

    queueSongStar(legacyId, true, 'srv-b', { scopedOverride: true });
    await vi.advanceTimersByTimeAsync(0);
    activateCanonicalNavidromeOwners(['srv-b']);
    queueSongStar(legacyId, false, 'srv-b', { scopedOverride: true });
    await vi.runAllTimersAsync();

    expect(unstarMock).toHaveBeenCalledWith(canonicalId, 'song', { serverId: 'srv-b' });
    expect(usePlayerStore.getState().starredOverrides).toEqual({
      [`srv-b:${canonicalId}`]: false,
    });
  });

  it('canonicalizes successful in-flight legacy work before success patches', async () => {
    const legacyId = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
    const canonicalId = canonicalizeNavidromeId(legacyId);
    let resolveStar!: () => void;
    starMock.mockImplementation(() => new Promise<void>(resolve => { resolveStar = resolve; }));
    seedQueueResolver('srv-b', [{ ...track(canonicalId), serverId: 'srv-b' }]);
    usePlayerStore.setState({
      currentTrack: { ...track(canonicalId), serverId: 'srv-b' },
      starredOverrides: {},
    });

    queueSongStar(legacyId, true, 'srv-b', { scopedOverride: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(starMock).toHaveBeenCalledWith(legacyId, 'song', { serverId: 'srv-b' });

    activateCanonicalNavidromeOwners(['srv-b']);
    resolveStar();
    await Promise.resolve();
    await Promise.resolve();

    expect(usePlayerStore.getState().starredOverrides).toEqual({
      [`srv-b:${canonicalId}`]: true,
    });
    expect(usePlayerStore.getState().currentTrack?.starred).toBeTruthy();
    expect(getCachedTrack({ serverId: 'srv-b', trackId: canonicalId })?.starred).toBeTruthy();
  });
});
