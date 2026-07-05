import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';

const { savePlayQueueMock, playerState, progressSnapshot, isSubsonicServerReachableMock } = vi.hoisted(() => ({
  savePlayQueueMock: vi.fn(async () => undefined),
  isSubsonicServerReachableMock: vi.fn((_serverId: string) => true),
  playerState: {
    queueItems: [] as QueueItemRef[],
    currentTrack: null as Track | null,
    currentRadio: null as { id: string } | null,
  },
  progressSnapshot: { currentTime: 0, progress: 0, buffered: 0 },
}));

vi.mock('@/lib/api/subsonicPlayQueue', () => ({ savePlayQueue: savePlayQueueMock }));
vi.mock('@/lib/network/subsonicNetworkGuard', () => ({
  isSubsonicServerReachable: (serverId: string) => isSubsonicServerReachableMock(serverId),
}));
vi.mock('@/features/playback/utils/playback/playbackServer', () => ({
  getPlaybackServerId: () => 'srv-a',
  playbackProfileIdForTrack: (track: Track) => track.serverId ?? 'srv-a',
  filterQueueRefsForPlaybackServer: (refs: QueueItemRef[]) =>
    refs.filter(r => r.serverId === 'a.test' || r.serverId === 'srv-a'),
}));
vi.mock('@/features/playback/utils/playback/trackServerScope', () => ({
  filterQueueRefsForServerProfile: (refs: QueueItemRef[], profileId: string) =>
    refs.filter(r => r.serverId === profileId || (profileId === 'srv-a' && r.serverId === 'srv-a')),
}));
vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: { getState: () => playerState },
}));
vi.mock('@/features/playback/store/playbackProgress', () => ({
  getPlaybackProgressSnapshot: () => progressSnapshot,
}));

import {
  _resetQueueSyncForTest,
  finalizePlayQueueAtTrackEnd,
  flushPlayQueueForServer,
  flushPlayQueuePosition,
  flushQueueSyncToServer,
  getLastQueueHeartbeatAt,
  hasPendingQueueSync,
  pushQueueOnPlaybackStart,
  syncQueueToServer,
  syncUserQueueMutationToServer,
} from '@/features/playback/store/queueSync';
import {
  _resetQueuePlaybackIdleForTest,
  isIdleQueuePullSuspended,
  isQueueNaturallyEnded,
} from '@/features/playback/store/queuePlaybackIdle';

function track(id: string, serverId = 'srv-a'): Track {
  return { id, title: id, artist: 'A', album: 'X', albumId: 'X', duration: 100, serverId };
}

function ref(id: string, serverId = 'a.test'): QueueItemRef {
  return { serverId, trackId: id };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));
  isSubsonicServerReachableMock.mockReturnValue(true);
  savePlayQueueMock.mockClear();
  savePlayQueueMock.mockResolvedValue(undefined);
  playerState.queueItems = [];
  playerState.currentTrack = null;
  playerState.currentRadio = null;
  progressSnapshot.currentTime = 0;
  _resetQueuePlaybackIdleForTest();
});

afterEach(() => {
  _resetQueueSyncForTest();
  vi.useRealTimers();
});

describe('syncQueueToServer (debounced)', () => {
  const queue = [ref('a'), ref('b')];

  it('skips sync while the playback server is unreachable', () => {
    isSubsonicServerReachableMock.mockReturnValue(false);
    syncQueueToServer(queue, track('a'), 30);
    vi.advanceTimersByTime(5000);
    expect(savePlayQueueMock).not.toHaveBeenCalled();
  });

  it('fires once after 5 s with id list + current id + position in ms', () => {
    syncQueueToServer(queue, track('a'), 30);
    vi.advanceTimersByTime(5000);
    expect(savePlayQueueMock).toHaveBeenCalledWith(['a', 'b'], 'a', 30000, 'srv-a');
  });

  it('sends only refs owned by the playback server in a mixed queue', () => {
    const mixed = [ref('a', 'a.test'), ref('b', 'b.test')];
    syncQueueToServer(mixed, track('a', 'srv-a'), 12);
    vi.advanceTimersByTime(5000);
    expect(savePlayQueueMock).toHaveBeenCalledWith(['a'], 'a', 12000, 'srv-a');
  });

  it('does not suspend idle pull during playback sync', () => {
    syncQueueToServer(queue, track('a'), 30);
    expect(isIdleQueuePullSuspended()).toBe(false);
  });
});

describe('syncUserQueueMutationToServer (debounced)', () => {
  const queue = [ref('a'), ref('b')];

  it('suspends idle pull on user mutation and stays suspended after successful debounced push', async () => {
    syncUserQueueMutationToServer(queue, track('a'), 30);
    expect(isIdleQueuePullSuspended()).toBe(true);
    expect(hasPendingQueueSync()).toBe(true);
    vi.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(savePlayQueueMock).toHaveBeenCalled();
    expect(isIdleQueuePullSuspended()).toBe(true);
  });

  it('keeps idle pull suspended when debounced push fails', async () => {
    savePlayQueueMock.mockRejectedValueOnce(new Error('offline'));
    syncUserQueueMutationToServer(queue, track('a'), 30);
    vi.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(isIdleQueuePullSuspended()).toBe(true);
  });
});

describe('pushQueueOnPlaybackStart', () => {
  const queue = [ref('a'), ref('b')];

  it('flushes immediately and clears idle pull suspension when locally edited', async () => {
    syncUserQueueMutationToServer(queue, track('a'), 30);
    expect(hasPendingQueueSync()).toBe(true);
    pushQueueOnPlaybackStart(queue, track('a'), 42);
    expect(hasPendingQueueSync()).toBe(false);
    await vi.runAllTimersAsync();
    expect(savePlayQueueMock).toHaveBeenCalledWith(['a', 'b'], 'a', 42000, 'srv-a');
    expect(isIdleQueuePullSuspended()).toBe(false);
  });

  it('debounces when idle pull is not suspended', () => {
    pushQueueOnPlaybackStart(queue, track('a'), 12);
    expect(hasPendingQueueSync()).toBe(true);
    expect(savePlayQueueMock).not.toHaveBeenCalled();
  });
});

describe('flushPlayQueueForServer', () => {
  it('flushes only the target server slice', async () => {
    playerState.queueItems = [ref('a', 'srv-a'), ref('b', 'b.test')];
    playerState.currentTrack = track('a', 'srv-a');
    progressSnapshot.currentTime = 9;
    await flushPlayQueueForServer('srv-a');
    expect(savePlayQueueMock).toHaveBeenCalledWith(['a'], 'a', 9000, 'srv-a');
  });
});

describe('flushQueueSyncToServer (immediate)', () => {
  it('fires synchronously with no debounce', async () => {
    await flushQueueSyncToServer([ref('a')], track('a'), 12);
    expect(savePlayQueueMock).toHaveBeenCalledWith(['a'], 'a', 12000, 'srv-a');
  });

  it('records the heartbeat timestamp', async () => {
    expect(getLastQueueHeartbeatAt()).toBe(0);
    await flushQueueSyncToServer([ref('a')], track('a'), 5);
    expect(getLastQueueHeartbeatAt()).toBe(Date.now());
  });
});

describe('flushPlayQueuePosition', () => {
  it('reads the current playerStore queue + playback-progress time', async () => {
    playerState.queueItems = [ref('a'), ref('b')];
    playerState.currentTrack = track('a');
    progressSnapshot.currentTime = 42;
    await flushPlayQueuePosition();
    expect(savePlayQueueMock).toHaveBeenCalledWith(['a', 'b'], 'a', 42000, 'srv-a');
  });

  it('is a no-op when a radio session is active', async () => {
    playerState.queueItems = [ref('a')];
    playerState.currentTrack = track('a');
    playerState.currentRadio = { id: 'radio-1' };
    await flushPlayQueuePosition();
    expect(savePlayQueueMock).not.toHaveBeenCalled();
  });
});

describe('finalizePlayQueueAtTrackEnd', () => {
  it('flushes immediately at track duration and marks the queue naturally ended', async () => {
    const queue = [ref('a'), ref('b')];
    const current = track('b');
    current.duration = 245;
    syncQueueToServer(queue, current, 120);
    await finalizePlayQueueAtTrackEnd(queue, current);
    expect(savePlayQueueMock).toHaveBeenCalledTimes(1);
    expect(savePlayQueueMock).toHaveBeenCalledWith(['a', 'b'], 'b', 245000, 'srv-a');
    expect(isQueueNaturallyEnded()).toBe(true);
    expect(hasPendingQueueSync()).toBe(false);
  });
});
