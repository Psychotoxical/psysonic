/**
 * Derived normalization snapshot — three engine branches and a couple of
 * replaygain corner cases (no tag → fallback, neighbour-track context for
 * album-mode resolution). useAuthStore is mocked through a hoisted state
 * object so each test can flip flags without rebuilding the store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from './playerStore';

const { authState } = vi.hoisted(() => ({
  authState: {
    normalizationEngine: 'off' as 'off' | 'replaygain' | 'loudness',
    loudnessTargetLufs: -14,
    replayGainEnabled: false,
    replayGainMode: 'track' as 'track' | 'album',
    replayGainPreGainDb: 0,
    replayGainFallbackDb: -6,
  },
}));

vi.mock('./authStore', () => ({
  useAuthStore: { getState: () => authState },
}));

vi.mock('../utils/resolveReplayGainDb', () => ({
  resolveReplayGainDb: vi.fn(
    (track: Track) => (track as Track & { _testGain?: number | null })._testGain ?? null,
  ),
}));

import { deriveNormalizationSnapshot } from './normalizationSnapshot';

function track(id: string, gain: number | null = null): Track {
  return {
    id,
    title: id,
    artist: 'A',
    album: 'X',
    albumId: 'X',
    duration: 100,
    ...(gain !== null ? { _testGain: gain } : {}),
  } as Track;
}

beforeEach(() => {
  authState.normalizationEngine = 'off';
  authState.loudnessTargetLufs = -14;
  authState.replayGainEnabled = false;
  authState.replayGainMode = 'track';
  authState.replayGainPreGainDb = 0;
  authState.replayGainFallbackDb = -6;
});

describe("engine='off'", () => {
  it('returns a fully-null snapshot', () => {
    expect(deriveNormalizationSnapshot(track('a'), [track('a')], 0)).toEqual({
      normalizationNowDb: null,
      normalizationTargetLufs: null,
      normalizationEngineLive: 'off',
    });
  });
});

describe("engine='loudness'", () => {
  it('returns the configured target LUFS and clears nowDb', () => {
    authState.normalizationEngine = 'loudness';
    authState.loudnessTargetLufs = -10;
    expect(deriveNormalizationSnapshot(track('a'), [track('a')], 0)).toEqual({
      normalizationNowDb: null,
      normalizationTargetLufs: -10,
      normalizationEngineLive: 'loudness',
    });
  });
});

describe("engine='replaygain'", () => {
  it("falls through to 'off' when replayGainEnabled is false", () => {
    authState.normalizationEngine = 'replaygain';
    authState.replayGainEnabled = false;
    expect(deriveNormalizationSnapshot(track('a'), [track('a')], 0).normalizationEngineLive).toBe('off');
  });

  it('uses the resolved gain + pre-gain when a tag is present', () => {
    authState.normalizationEngine = 'replaygain';
    authState.replayGainEnabled = true;
    authState.replayGainPreGainDb = 2;
    const snap = deriveNormalizationSnapshot(track('a', -8), [track('a', -8)], 0);
    expect(snap.normalizationNowDb).toBe(-6); // -8 + 2
    expect(snap.normalizationEngineLive).toBe('replaygain');
    expect(snap.normalizationTargetLufs).toBeNull();
  });

  it('uses the fallback dB when no tag is resolvable', () => {
    authState.normalizationEngine = 'replaygain';
    authState.replayGainEnabled = true;
    authState.replayGainFallbackDb = -3;
    const snap = deriveNormalizationSnapshot(track('a'), [track('a')], 0);
    expect(snap.normalizationNowDb).toBe(-3);
    expect(snap.normalizationEngineLive).toBe('replaygain');
  });

  it('passes neighbour-track context for album-mode resolution', async () => {
    const { resolveReplayGainDb } = await import('../utils/resolveReplayGainDb');
    const spy = vi.mocked(resolveReplayGainDb);
    spy.mockClear();
    authState.normalizationEngine = 'replaygain';
    authState.replayGainEnabled = true;
    authState.replayGainMode = 'album';
    const queue = [track('prev'), track('current'), track('next')];
    deriveNormalizationSnapshot(queue[1], queue, 1);
    expect(spy).toHaveBeenCalledWith(queue[1], queue[0], queue[2], true, 'album');
  });

  it('passes null for prev when queueIndex is 0', async () => {
    const { resolveReplayGainDb } = await import('../utils/resolveReplayGainDb');
    const spy = vi.mocked(resolveReplayGainDb);
    spy.mockClear();
    authState.normalizationEngine = 'replaygain';
    authState.replayGainEnabled = true;
    const queue = [track('a'), track('b')];
    deriveNormalizationSnapshot(queue[0], queue, 0);
    expect(spy.mock.calls[0][1]).toBeNull();
    expect(spy.mock.calls[0][2]).toEqual(queue[1]);
  });

  it('passes null for next when queueIndex is the last slot', async () => {
    const { resolveReplayGainDb } = await import('../utils/resolveReplayGainDb');
    const spy = vi.mocked(resolveReplayGainDb);
    spy.mockClear();
    authState.normalizationEngine = 'replaygain';
    authState.replayGainEnabled = true;
    const queue = [track('a'), track('b')];
    deriveNormalizationSnapshot(queue[1], queue, 1);
    expect(spy.mock.calls[0][1]).toEqual(queue[0]);
    expect(spy.mock.calls[0][2]).toBeNull();
  });
});
