/**
 * `prefetchLoudnessForEnqueuedTracks` warms the loudness cache for the
 * current + next-N tracks after a bulk enqueue. Tests pin the engine
 * guard, the window collection, and the no-sync-engine flag on each
 * refresh call.
 */
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const hoisted = vi.hoisted(() => {
  const auth = { normalizationEngine: 'loudness' as 'off' | 'replaygain' | 'loudness' };
  const player = { currentTrack: null as Track | null };
  return {
    auth,
    player,
    refreshMock: vi.fn(async () => undefined),
    collectMock: vi.fn((_q: QueueItemRef[], _i: number, _c: Track | null): string[] => []),
  };
});

vi.mock('@/store/authStore', () => ({ useAuthStore: { getState: () => hoisted.auth } }));
vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: { getState: () => hoisted.player },
}));
vi.mock('@/features/playback/store/loudnessRefresh', () => ({
  refreshLoudnessForTrack: hoisted.refreshMock,
}));
vi.mock('@/features/playback/store/loudnessBackfillWindow', () => ({
  collectLoudnessBackfillWindowTrackIds: hoisted.collectMock,
}));

import { prefetchLoudnessForEnqueuedTracks } from '@/features/playback/store/loudnessPrefetch';

function track(id: string): Track {
  return { id, title: id, artist: 'A', album: 'X', albumId: 'X', duration: 100 };
}

// Thin-state: prefetchLoudnessForEnqueuedTracks takes queue refs now.
function ref(id: string): QueueItemRef {
  return { serverId: 's', trackId: id };
}

beforeEach(() => {
  hoisted.auth.normalizationEngine = 'loudness';
  hoisted.player.currentTrack = null;
  hoisted.refreshMock.mockClear();
  hoisted.collectMock.mockReset();
  hoisted.collectMock.mockReturnValue([]);
});

describe('prefetchLoudnessForEnqueuedTracks', () => {
  it("is a no-op when engine isn't loudness", () => {
    hoisted.auth.normalizationEngine = 'off';
    hoisted.collectMock.mockReturnValueOnce(['t1']);
    prefetchLoudnessForEnqueuedTracks([ref('t1')], 0);
    expect(hoisted.refreshMock).not.toHaveBeenCalled();
    expect(hoisted.collectMock).not.toHaveBeenCalled();
  });

  it('forwards each window id to refreshLoudnessForTrack with syncPlayingEngine=false', () => {
    hoisted.collectMock.mockReturnValueOnce(['t1', 't2', 't3']);
    prefetchLoudnessForEnqueuedTracks([ref('t1'), ref('t2'), ref('t3')], 0);
    expect(hoisted.refreshMock).toHaveBeenCalledTimes(3);
    expect(hoisted.refreshMock).toHaveBeenCalledWith('t1', { syncPlayingEngine: false });
    expect(hoisted.refreshMock).toHaveBeenCalledWith('t2', { syncPlayingEngine: false });
    expect(hoisted.refreshMock).toHaveBeenCalledWith('t3', { syncPlayingEngine: false });
  });

  it('passes the queue + currentTrack through to the window collector', () => {
    hoisted.player.currentTrack = track('cur');
    const q = [ref('cur'), ref('next')];
    prefetchLoudnessForEnqueuedTracks(q, 0);
    expect(hoisted.collectMock).toHaveBeenCalledWith(q, 0, hoisted.player.currentTrack);
  });

  it('handles empty window list gracefully', () => {
    hoisted.collectMock.mockReturnValueOnce([]);
    prefetchLoudnessForEnqueuedTracks([], 0);
    expect(hoisted.refreshMock).not.toHaveBeenCalled();
  });
});
