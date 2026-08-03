/**
 * `refreshWaveformForTrack` fetches an analysis row from Rust and applies
 * it to the player store — but only if the refresh generation hasn't been
 * bumped meanwhile and the track is still current. The tests pin both
 * guards and the success / null-row / empty-bins / error branches.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => null as unknown),
  coerceWaveformBinsMock: vi.fn((bins: unknown) => {
    if (bins == null) return null;
    if (Array.isArray(bins) && bins.length === 0) return null;
    return bins as number[];
  }),
  playerSnapshot: {
    currentTrack: null as { id: string; serverId?: string } | null,
    queueItems: [] as Array<{ trackId: string; serverId: string }>,
    queueIndex: 0,
  },
  playerSetStateMock: vi.fn(),
  gen: 0,
  getGenMock: vi.fn(() => hoisted.gen),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: hoisted.invokeMock }));
vi.mock('@/lib/waveform/waveformParse', () => ({ coerceWaveformBins: hoisted.coerceWaveformBinsMock }));
vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: {
    getState: () => hoisted.playerSnapshot,
    setState: hoisted.playerSetStateMock,
  },
}));
vi.mock('@/features/playback/store/waveformRefreshGen', () => ({
  getWaveformRefreshGen: hoisted.getGenMock,
}));

import {
  _resetWaveformRefreshInflightForTest,
  fetchWaveformBins,
  refreshWaveformForTrack,
} from '@/features/playback/store/waveformRefresh';
import { analysisTrackRef } from '@/features/playback/store/analysisTrackRef';

const ref = (trackId: string, serverId = 'server-a') => analysisTrackRef(trackId, serverId);

function setCurrent(trackId: string, serverId = 'server-a'): void {
  hoisted.playerSnapshot.currentTrack = { id: trackId, serverId };
  hoisted.playerSnapshot.queueItems = [{ trackId, serverId }];
  hoisted.playerSnapshot.queueIndex = 0;
}

beforeEach(() => {
  _resetWaveformRefreshInflightForTest();
  hoisted.invokeMock.mockReset();
  hoisted.invokeMock.mockResolvedValue(null);
  hoisted.coerceWaveformBinsMock.mockClear();
  hoisted.playerSetStateMock.mockClear();
  hoisted.playerSnapshot.currentTrack = null;
  hoisted.playerSnapshot.queueItems = [];
  hoisted.playerSnapshot.queueIndex = 0;
  hoisted.gen = 0;
});

describe('refreshWaveformForTrack', () => {
  it('is a no-op for empty trackId', async () => {
    await refreshWaveformForTrack(ref(''));
    expect(hoisted.invokeMock).not.toHaveBeenCalled();
  });

  it('does not query waveform storage for an unknown profile UUID', async () => {
    await refreshWaveformForTrack(ref('t1', '9ee02895-4d12-4faa-9a9f-3fae22b64d18'));
    expect(hoisted.invokeMock).not.toHaveBeenCalled();
  });

  it('coalesces concurrent reads for the same track and generation', async () => {
    setCurrent('t1');
    let resolveFetch!: (value: unknown) => void;
    hoisted.invokeMock.mockImplementationOnce(() => new Promise(resolve => { resolveFetch = resolve; }));
    const first = refreshWaveformForTrack(ref('t1'));
    const second = refreshWaveformForTrack(ref('t1'));
    expect(hoisted.invokeMock).toHaveBeenCalledTimes(1);
    resolveFetch({ bins: [1, 2, 3] });
    await Promise.all([first, second]);
    expect(hoisted.playerSetStateMock).toHaveBeenCalledTimes(1);
  });

  it('shares a cached miss with silence-aware playback reads in the same generation', async () => {
    setCurrent('t1');
    hoisted.invokeMock.mockResolvedValueOnce(null);

    await refreshWaveformForTrack(ref('t1'));
    const bins = await fetchWaveformBins(ref('t1'));

    expect(bins).toBeNull();
    expect(hoisted.invokeMock).toHaveBeenCalledTimes(1);
  });

  it('starts a new read after the refresh generation changes', async () => {
    setCurrent('t1');
    let resolveFirst!: (value: unknown) => void;
    hoisted.invokeMock.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    const first = refreshWaveformForTrack(ref('t1'));
    hoisted.gen = 1;
    hoisted.invokeMock.mockResolvedValueOnce({ bins: [4, 5, 6] });
    const second = refreshWaveformForTrack(ref('t1'));
    expect(hoisted.invokeMock).toHaveBeenCalledTimes(2);
    resolveFirst({ bins: [1, 2, 3] });
    await Promise.all([first, second]);
    expect(hoisted.playerSetStateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.playerSetStateMock).toHaveBeenCalledWith({ waveformBins: [4, 5, 6] });
  });

  it('discards results when the gen has been bumped since the call started', async () => {
    setCurrent('t1');
    hoisted.invokeMock.mockImplementationOnce(async () => {
      hoisted.gen = 99; // simulate concurrent bump
      return { bins: [1, 2, 3] };
    });
    await refreshWaveformForTrack(ref('t1'));
    expect(hoisted.playerSetStateMock).not.toHaveBeenCalled();
  });

  it('skips when the track is no longer current after the fetch', async () => {
    setCurrent('other');
    hoisted.invokeMock.mockResolvedValueOnce({ bins: [1, 2, 3] });
    await refreshWaveformForTrack(ref('t1'));
    expect(hoisted.playerSetStateMock).not.toHaveBeenCalled();
  });

  it('skips the same raw id when the current track belongs to another server', async () => {
    setCurrent('same', 'server-b');
    hoisted.invokeMock.mockResolvedValueOnce({ bins: [1, 2, 3] });
    await refreshWaveformForTrack(ref('same', 'server-a'));
    expect(hoisted.playerSetStateMock).not.toHaveBeenCalled();
  });

  it('blanks bins when the row is null', async () => {
    setCurrent('t1');
    hoisted.invokeMock.mockResolvedValueOnce(null);
    await refreshWaveformForTrack(ref('t1'));
    expect(hoisted.playerSetStateMock).toHaveBeenCalledWith({ waveformBins: null });
  });

  it('blanks bins when coerceWaveformBins returns null (invalid shape)', async () => {
    setCurrent('t1');
    hoisted.invokeMock.mockResolvedValueOnce({ bins: 'garbage' });
    hoisted.coerceWaveformBinsMock.mockReturnValueOnce(null);
    await refreshWaveformForTrack(ref('t1'));
    expect(hoisted.playerSetStateMock).toHaveBeenCalledWith({ waveformBins: null });
  });

  it('applies the coerced bins on a clean fetch', async () => {
    setCurrent('t1');
    hoisted.invokeMock.mockResolvedValueOnce({ bins: [10, 20, 30] });
    hoisted.coerceWaveformBinsMock.mockReturnValueOnce([10, 20, 30]);
    await refreshWaveformForTrack(ref('t1'));
    expect(hoisted.playerSetStateMock).toHaveBeenCalledWith({ waveformBins: [10, 20, 30] });
    expect(hoisted.invokeMock).toHaveBeenCalledWith('analysis_get_waveform_for_track', {
      trackId: 't1',
      serverId: 'server-a',
    });
  });

  it('swallows fetch errors silently (placeholder waveform stays)', async () => {
    setCurrent('t1');
    hoisted.invokeMock.mockRejectedValueOnce(new Error('boom'));
    await expect(refreshWaveformForTrack(ref('t1'))).resolves.toBeUndefined();
    expect(hoisted.playerSetStateMock).not.toHaveBeenCalled();
  });
});
