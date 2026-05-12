/**
 * `reseedLoudnessForTrackId` orchestrates a full analysis re-run for one
 * track: invalidate waveform gen, clear loudness + backfill state, wipe
 * server rows, kick a forced seed. The orchestration is what's worth
 * pinning — each individual helper is already tested in its own module.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const authState = {
    normalizationEngine: 'loudness' as 'off' | 'replaygain' | 'loudness',
    loudnessTargetLufs: -14,
  };
  const playerSnapshot: {
    currentTrack: { id: string } | null;
    updateReplayGainForCurrentTrack: ReturnType<typeof vi.fn>;
  } = {
    currentTrack: null,
    updateReplayGainForCurrentTrack: vi.fn(),
  };
  return {
    authState,
    playerSnapshot,
    invokeMock: vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => undefined),
    buildStreamUrlMock: vi.fn((id: string) => `https://mock/stream/${id}`),
    bumpWaveformRefreshGenMock: vi.fn(),
    clearLoudnessCacheMock: vi.fn(),
    resetBackfillStateMock: vi.fn(),
    playerSetStateMock: vi.fn(),
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: hoisted.invokeMock }));
vi.mock('../api/subsonic', () => ({ buildStreamUrl: hoisted.buildStreamUrlMock }));
vi.mock('./authStore', () => ({ useAuthStore: { getState: () => hoisted.authState } }));
vi.mock('./playerStore', () => ({
  usePlayerStore: {
    getState: () => hoisted.playerSnapshot,
    setState: hoisted.playerSetStateMock,
  },
}));
vi.mock('./waveformRefreshGen', () => ({
  bumpWaveformRefreshGen: hoisted.bumpWaveformRefreshGenMock,
}));
vi.mock('./loudnessGainCache', () => ({
  clearLoudnessCacheStateForTrackId: hoisted.clearLoudnessCacheMock,
}));
vi.mock('./loudnessBackfillState', () => ({
  resetLoudnessBackfillStateForTrackId: hoisted.resetBackfillStateMock,
}));

import { reseedLoudnessForTrackId } from './loudnessReseed';

beforeEach(() => {
  hoisted.authState.normalizationEngine = 'loudness';
  hoisted.authState.loudnessTargetLufs = -14;
  hoisted.playerSnapshot.currentTrack = null;
  hoisted.invokeMock.mockReset();
  hoisted.invokeMock.mockResolvedValue(undefined);
  hoisted.buildStreamUrlMock.mockClear();
  hoisted.bumpWaveformRefreshGenMock.mockClear();
  hoisted.clearLoudnessCacheMock.mockClear();
  hoisted.resetBackfillStateMock.mockClear();
  hoisted.playerSetStateMock.mockClear();
  hoisted.playerSnapshot.updateReplayGainForCurrentTrack = vi.fn();
});

describe('reseedLoudnessForTrackId', () => {
  it('is a no-op for empty trackId', async () => {
    await reseedLoudnessForTrackId('');
    expect(hoisted.invokeMock).not.toHaveBeenCalled();
    expect(hoisted.bumpWaveformRefreshGenMock).not.toHaveBeenCalled();
  });

  it("is a no-op when normalization engine isn't loudness", async () => {
    hoisted.authState.normalizationEngine = 'off';
    await reseedLoudnessForTrackId('t1');
    expect(hoisted.invokeMock).not.toHaveBeenCalled();
    expect(hoisted.bumpWaveformRefreshGenMock).not.toHaveBeenCalled();
  });

  it('runs the full reseed pipeline in order', async () => {
    await reseedLoudnessForTrackId('t1');
    expect(hoisted.bumpWaveformRefreshGenMock).toHaveBeenCalledWith('t1');
    expect(hoisted.clearLoudnessCacheMock).toHaveBeenCalledWith('t1');
    expect(hoisted.resetBackfillStateMock).toHaveBeenCalledWith('t1');
    const invokeCalls = hoisted.invokeMock.mock.calls.map(c => c[0]);
    expect(invokeCalls).toEqual([
      'analysis_delete_waveform_for_track',
      'analysis_delete_loudness_for_track',
      'analysis_enqueue_seed_from_url',
    ]);
    expect(hoisted.invokeMock.mock.calls[2][1]).toEqual({
      trackId: 't1',
      url: 'https://mock/stream/t1',
      force: true,
    });
  });

  it('blanks the seekbar only when the reseed target is the current track', async () => {
    hoisted.playerSnapshot.currentTrack = { id: 't1' };
    await reseedLoudnessForTrackId('t1');
    const setStateCalls = hoisted.playerSetStateMock.mock.calls.map(c => c[0]);
    expect(setStateCalls).toContainEqual({ waveformBins: null });
  });

  it('does NOT blank the seekbar when reseeding a different track', async () => {
    hoisted.playerSnapshot.currentTrack = { id: 'other' };
    await reseedLoudnessForTrackId('t1');
    const setStateCalls = hoisted.playerSetStateMock.mock.calls.map(c => c[0]);
    expect(setStateCalls).not.toContainEqual({ waveformBins: null });
  });

  it('resets live normalization-state to placeholder values', async () => {
    hoisted.authState.loudnessTargetLufs = -10;
    await reseedLoudnessForTrackId('t1');
    const setStateCalls = hoisted.playerSetStateMock.mock.calls.map(c => c[0]);
    expect(setStateCalls).toContainEqual({
      normalizationNowDb: null,
      normalizationTargetLufs: -10,
      normalizationEngineLive: 'loudness',
    });
  });

  it('continues past errors in delete-waveform', async () => {
    hoisted.invokeMock
      .mockRejectedValueOnce(new Error('waveform delete failed'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    await reseedLoudnessForTrackId('t1');
    expect(hoisted.invokeMock).toHaveBeenCalledTimes(3);
  });

  it('continues past errors in delete-loudness', async () => {
    hoisted.invokeMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('loudness delete failed'))
      .mockResolvedValueOnce(undefined);
    await reseedLoudnessForTrackId('t1');
    expect(hoisted.invokeMock).toHaveBeenCalledTimes(3);
  });

  it('swallows the final enqueue-seed error', async () => {
    hoisted.invokeMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('enqueue failed'));
    await expect(reseedLoudnessForTrackId('t1')).resolves.toBeUndefined();
  });
});
