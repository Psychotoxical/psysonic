/**
 * Server-queue-sync helpers: the 5-second debounce, the immediate flush,
 * the queue-id cap, and the radio-skip guard inside
 * `flushPlayQueuePosition`. Fake timers drive the debounce; mocks stand
 * in for `savePlayQueue`, the playerStore, and the playback-progress
 * snapshot.
 */
import type { Track } from './playerStoreTypes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { savePlayQueueMock, playerState, progressSnapshot } = vi.hoisted(() => ({
  savePlayQueueMock: vi.fn(async (_ids: string[], _currentId: string | undefined, _pos: number) => undefined),
  playerState: {
    queue: [] as Track[],
    currentTrack: null as Track | null,
    currentRadio: null as { id: string } | null,
  },
  progressSnapshot: { currentTime: 0, progress: 0, buffered: 0 },
}));

vi.mock('../api/subsonicPlayQueue', () => ({ savePlayQueue: savePlayQueueMock }));
vi.mock('./playerStore', () => ({
  usePlayerStore: { getState: () => playerState },
}));
vi.mock('./playbackProgress', () => ({
  getPlaybackProgressSnapshot: () => progressSnapshot,
}));

import {
  _resetQueueSyncForTest,
  flushPlayQueuePosition,
  flushQueueSyncToServer,
  getLastQueueHeartbeatAt,
  syncQueueToServer,
} from './queueSync';

function track(id: string): Track {
  return { id, title: id, artist: 'A', album: 'X', albumId: 'X', duration: 100 };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));
  savePlayQueueMock.mockClear();
  savePlayQueueMock.mockResolvedValue(undefined);
  playerState.queue = [];
  playerState.currentTrack = null;
  playerState.currentRadio = null;
  progressSnapshot.currentTime = 0;
});

afterEach(() => {
  _resetQueueSyncForTest();
  vi.useRealTimers();
});

describe('syncQueueToServer (debounced)', () => {
  const queue = [track('a'), track('b')];

  it('does not fire before 5 s elapse', () => {
    syncQueueToServer(queue, queue[0], 30);
    vi.advanceTimersByTime(4999);
    expect(savePlayQueueMock).not.toHaveBeenCalled();
  });

  it('fires once after 5 s with id list + current id + position in ms', () => {
    syncQueueToServer(queue, queue[0], 30);
    vi.advanceTimersByTime(5000);
    expect(savePlayQueueMock).toHaveBeenCalledWith(['a', 'b'], 'a', 30000);
  });

  it('cancels the previous timer when called again before fire', () => {
    syncQueueToServer(queue, queue[0], 10);
    vi.advanceTimersByTime(3000);
    syncQueueToServer([...queue, track('c')], queue[0], 20);
    vi.advanceTimersByTime(5000);
    expect(savePlayQueueMock).toHaveBeenCalledTimes(1);
    expect(savePlayQueueMock).toHaveBeenCalledWith(['a', 'b', 'c'], 'a', 20000);
  });

  it('caps the queue at 1000 ids', () => {
    const big = Array.from({ length: 1500 }, (_, i) => track(`t${i}`));
    syncQueueToServer(big, big[0], 0);
    vi.advanceTimersByTime(5000);
    const ids = savePlayQueueMock.mock.calls[0][0] as string[];
    expect(ids.length).toBe(1000);
    expect(ids[0]).toBe('t0');
    expect(ids[999]).toBe('t999');
  });
});

describe('flushQueueSyncToServer (immediate)', () => {
  it('fires synchronously with no debounce', async () => {
    await flushQueueSyncToServer([track('a')], track('a'), 12);
    expect(savePlayQueueMock).toHaveBeenCalledWith(['a'], 'a', 12000);
  });

  it('cancels a pending debounced sync first', async () => {
    syncQueueToServer([track('a')], track('a'), 30);
    await flushQueueSyncToServer([track('a')], track('a'), 31);
    expect(savePlayQueueMock).toHaveBeenCalledTimes(1);
    // After the flush returns, advancing past the debounce should not fire again.
    vi.advanceTimersByTime(10_000);
    expect(savePlayQueueMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when currentTrack is null', async () => {
    await flushQueueSyncToServer([track('a')], null, 5);
    expect(savePlayQueueMock).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty queue', async () => {
    await flushQueueSyncToServer([], track('a'), 5);
    expect(savePlayQueueMock).not.toHaveBeenCalled();
  });

  it('records the heartbeat timestamp', async () => {
    expect(getLastQueueHeartbeatAt()).toBe(0);
    await flushQueueSyncToServer([track('a')], track('a'), 5);
    expect(getLastQueueHeartbeatAt()).toBe(Date.now());
  });
});

describe('flushPlayQueuePosition', () => {
  it('reads the current playerStore queue + playback-progress time', async () => {
    playerState.queue = [track('a'), track('b')];
    playerState.currentTrack = playerState.queue[0];
    progressSnapshot.currentTime = 42;
    await flushPlayQueuePosition();
    expect(savePlayQueueMock).toHaveBeenCalledWith(['a', 'b'], 'a', 42000);
  });

  it('is a no-op when a radio session is active', async () => {
    playerState.queue = [track('a')];
    playerState.currentTrack = playerState.queue[0];
    playerState.currentRadio = { id: 'radio-1' };
    await flushPlayQueuePosition();
    expect(savePlayQueueMock).not.toHaveBeenCalled();
  });
});
