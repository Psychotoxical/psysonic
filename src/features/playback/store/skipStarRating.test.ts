/**
 * Skip → 1★ helper: drive each early-return branch + the happy path. The
 * threshold-crossing case now delegates the rating to `queueSongRating`
 * (pending-sync, F4) — its optimistic patch + retry behaviour is covered in
 * `pendingStarSync.test.ts`, so here we only assert the delegation + guards.
 */
import type { Track } from '@/lib/media/trackTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { queueSongRatingMock, recordSkipStarMock, playerStateGet } = vi.hoisted(() => {
  const playerState = {
    queueServerId: 's1' as string | null,
    currentTrack: null as Track | null,
    userRatingOverrides: {} as Record<string, number>,
  };
  return {
    queueSongRatingMock: vi.fn(),
    recordSkipStarMock: vi.fn(),
    playerStateGet: () => playerState,
  };
});

vi.mock('@/features/playback/store/pendingStarSync', () => ({ queueSongRating: queueSongRatingMock }));
vi.mock('@/store/authStore', () => ({
  useAuthStore: { getState: () => ({ recordSkipStarManualAdvance: recordSkipStarMock }) },
}));
vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: { getState: playerStateGet },
}));

import { applySkipStarOnManualNext } from '@/features/playback/store/skipStarRating';
import { seedQueueResolver, _resetQueueResolverForTest } from '@/features/playback/store/queueTrackResolver';

function track(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id, title: id, artist: 'A', album: 'X', albumId: 'X', duration: 100, ...overrides,
  };
}

beforeEach(() => {
  queueSongRatingMock.mockClear();
  recordSkipStarMock.mockReset();
  _resetQueueResolverForTest();
  const s = playerStateGet();
  s.queueServerId = 's1';
  s.currentTrack = null;
  s.userRatingOverrides = {};
});

describe('applySkipStarOnManualNext', () => {
  it('is a no-op when manual=false (gapless / natural advance)', () => {
    applySkipStarOnManualNext(track('t1'), false);
    expect(recordSkipStarMock).not.toHaveBeenCalled();
    expect(queueSongRatingMock).not.toHaveBeenCalled();
  });

  it('is a no-op when skippedTrack is null', () => {
    applySkipStarOnManualNext(null, true);
    expect(recordSkipStarMock).not.toHaveBeenCalled();
  });

  it('records the manual advance but does not rate when threshold not crossed', () => {
    recordSkipStarMock.mockReturnValueOnce({ crossedThreshold: false });
    applySkipStarOnManualNext(track('t1'), true);
    expect(recordSkipStarMock).toHaveBeenCalledWith('t1');
    expect(queueSongRatingMock).not.toHaveBeenCalled();
  });

  it('handles a null return from recordSkipStarManualAdvance gracefully', () => {
    recordSkipStarMock.mockReturnValueOnce(null);
    expect(() => applySkipStarOnManualNext(track('t1'), true)).not.toThrow();
    expect(queueSongRatingMock).not.toHaveBeenCalled();
  });

  it('skips rating when the track is already rated via the override map', () => {
    recordSkipStarMock.mockReturnValueOnce({ crossedThreshold: true });
    playerStateGet().userRatingOverrides = { t1: 3 };
    applySkipStarOnManualNext(track('t1'), true);
    expect(queueSongRatingMock).not.toHaveBeenCalled();
  });

  it('skips rating when the resolver-cached queue entry is already rated', () => {
    recordSkipStarMock.mockReturnValueOnce({ crossedThreshold: true });
    // Thin-state: the queue's track copy lives in the resolver cache.
    seedQueueResolver('s1', [track('t1', { userRating: 4 })]);
    applySkipStarOnManualNext(track('t1'), true);
    expect(queueSongRatingMock).not.toHaveBeenCalled();
  });

  it('skips rating when the passed track is already rated', () => {
    recordSkipStarMock.mockReturnValueOnce({ crossedThreshold: true });
    applySkipStarOnManualNext(track('t1', { userRating: 2 }), true);
    expect(queueSongRatingMock).not.toHaveBeenCalled();
  });

  it('delegates to queueSongRating(id, 1) when threshold crosses and the track is unrated', () => {
    recordSkipStarMock.mockReturnValueOnce({ crossedThreshold: true });
    applySkipStarOnManualNext(track('t1'), true);
    expect(queueSongRatingMock).toHaveBeenCalledWith('t1', 1);
  });
});
