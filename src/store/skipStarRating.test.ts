/**
 * Skip → 1★ helper: drive each early-return branch + the happy path through
 * the threshold-crossing flow that calls `setRating` and updates the
 * playerStore. Hoisted mocks replace `setRating`, the auth-store helper, and
 * the player-store state surface so the test can drive every input
 * independently.
 */
import type { Track } from './playerStoreTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { setRatingMock, recordSkipStarMock, playerSetStateMock, playerStateGet } = vi.hoisted(() => {
  const playerState = {
    queue: [] as Track[],
    currentTrack: null as Track | null,
    userRatingOverrides: {} as Record<string, number>,
  };
  return {
    setRatingMock: vi.fn(async () => undefined),
    recordSkipStarMock: vi.fn(),
    playerSetStateMock: vi.fn((updater: (s: typeof playerState) => Partial<typeof playerState>) => {
      Object.assign(playerState, updater(playerState));
    }),
    playerStateGet: () => playerState,
  };
});

vi.mock('../api/subsonicStarRating', () => ({ setRating: setRatingMock }));
vi.mock('./authStore', () => ({
  useAuthStore: { getState: () => ({ recordSkipStarManualAdvance: recordSkipStarMock }) },
}));
vi.mock('./playerStore', () => ({
  usePlayerStore: {
    getState: playerStateGet,
    setState: playerSetStateMock,
  },
}));

import { applySkipStarOnManualNext } from './skipStarRating';

function track(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id, title: id, artist: 'A', album: 'X', albumId: 'X', duration: 100, ...overrides,
  };
}

beforeEach(() => {
  setRatingMock.mockClear();
  recordSkipStarMock.mockReset();
  playerSetStateMock.mockClear();
  const s = playerStateGet();
  s.queue = [];
  s.currentTrack = null;
  s.userRatingOverrides = {};
});

describe('applySkipStarOnManualNext', () => {
  it('is a no-op when manual=false (gapless / natural advance)', () => {
    applySkipStarOnManualNext(track('t1'), false);
    expect(recordSkipStarMock).not.toHaveBeenCalled();
    expect(setRatingMock).not.toHaveBeenCalled();
  });

  it('is a no-op when skippedTrack is null', () => {
    applySkipStarOnManualNext(null, true);
    expect(recordSkipStarMock).not.toHaveBeenCalled();
  });

  it('records the manual advance but does not rate when threshold not crossed', () => {
    recordSkipStarMock.mockReturnValueOnce({ crossedThreshold: false });
    applySkipStarOnManualNext(track('t1'), true);
    expect(recordSkipStarMock).toHaveBeenCalledWith('t1');
    expect(setRatingMock).not.toHaveBeenCalled();
  });

  it('handles a null return from recordSkipStarManualAdvance gracefully', () => {
    recordSkipStarMock.mockReturnValueOnce(null);
    expect(() => applySkipStarOnManualNext(track('t1'), true)).not.toThrow();
    expect(setRatingMock).not.toHaveBeenCalled();
  });

  it("skips rating when the track is already rated via the override map", () => {
    recordSkipStarMock.mockReturnValueOnce({ crossedThreshold: true });
    playerStateGet().userRatingOverrides = { t1: 3 };
    applySkipStarOnManualNext(track('t1'), true);
    expect(setRatingMock).not.toHaveBeenCalled();
  });

  it('skips rating when the queue entry is already rated', () => {
    recordSkipStarMock.mockReturnValueOnce({ crossedThreshold: true });
    playerStateGet().queue = [track('t1', { userRating: 4 })];
    applySkipStarOnManualNext(track('t1'), true);
    expect(setRatingMock).not.toHaveBeenCalled();
  });

  it('skips rating when the passed track is already rated', () => {
    recordSkipStarMock.mockReturnValueOnce({ crossedThreshold: true });
    applySkipStarOnManualNext(track('t1', { userRating: 2 }), true);
    expect(setRatingMock).not.toHaveBeenCalled();
  });

  it('calls setRating(1) when threshold crosses and the track is unrated', async () => {
    recordSkipStarMock.mockReturnValueOnce({ crossedThreshold: true });
    applySkipStarOnManualNext(track('t1'), true);
    expect(setRatingMock).toHaveBeenCalledWith('t1', 1);
    await Promise.resolve();
    expect(playerSetStateMock).toHaveBeenCalledTimes(1);
    const updated = playerStateGet();
    expect(updated.userRatingOverrides).toEqual({ t1: 1 });
  });

  it('updates queue + currentTrack when the skipped track is the current one', async () => {
    recordSkipStarMock.mockReturnValueOnce({ crossedThreshold: true });
    const s = playerStateGet();
    s.queue = [track('t1'), track('t2')];
    s.currentTrack = s.queue[0];
    applySkipStarOnManualNext(track('t1'), true);
    await Promise.resolve();
    const updated = playerStateGet();
    expect(updated.queue[0].userRating).toBe(1);
    expect(updated.queue[1].userRating).toBeUndefined();
    expect(updated.currentTrack?.userRating).toBe(1);
  });

  it('swallows setRating rejections silently', async () => {
    recordSkipStarMock.mockReturnValueOnce({ crossedThreshold: true });
    setRatingMock.mockRejectedValueOnce(new Error('network down'));
    expect(() => applySkipStarOnManualNext(track('t1'), true)).not.toThrow();
    // Drain the rejected microtask
    await Promise.resolve();
    await Promise.resolve();
  });
});
