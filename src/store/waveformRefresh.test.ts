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
    currentTrack: null as { id: string } | null,
  },
  playerSetStateMock: vi.fn(),
  gen: 0,
  getGenMock: vi.fn(() => hoisted.gen),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: hoisted.invokeMock }));
vi.mock('../utils/waveformParse', () => ({ coerceWaveformBins: hoisted.coerceWaveformBinsMock }));
vi.mock('./playerStore', () => ({
  usePlayerStore: {
    getState: () => hoisted.playerSnapshot,
    setState: hoisted.playerSetStateMock,
  },
}));
vi.mock('./waveformRefreshGen', () => ({
  getWaveformRefreshGen: hoisted.getGenMock,
}));

import { refreshWaveformForTrack } from './waveformRefresh';

beforeEach(() => {
  hoisted.invokeMock.mockReset();
  hoisted.invokeMock.mockResolvedValue(null);
  hoisted.coerceWaveformBinsMock.mockClear();
  hoisted.playerSetStateMock.mockClear();
  hoisted.playerSnapshot.currentTrack = null;
  hoisted.gen = 0;
});

describe('refreshWaveformForTrack', () => {
  it('is a no-op for empty trackId', async () => {
    await refreshWaveformForTrack('');
    expect(hoisted.invokeMock).not.toHaveBeenCalled();
  });

  it('discards results when the gen has been bumped since the call started', async () => {
    hoisted.playerSnapshot.currentTrack = { id: 't1' };
    hoisted.invokeMock.mockImplementationOnce(async () => {
      hoisted.gen = 99; // simulate concurrent bump
      return { bins: [1, 2, 3] };
    });
    await refreshWaveformForTrack('t1');
    expect(hoisted.playerSetStateMock).not.toHaveBeenCalled();
  });

  it('skips when the track is no longer current after the fetch', async () => {
    hoisted.playerSnapshot.currentTrack = { id: 'other' };
    hoisted.invokeMock.mockResolvedValueOnce({ bins: [1, 2, 3] });
    await refreshWaveformForTrack('t1');
    expect(hoisted.playerSetStateMock).not.toHaveBeenCalled();
  });

  it('blanks bins when the row is null', async () => {
    hoisted.playerSnapshot.currentTrack = { id: 't1' };
    hoisted.invokeMock.mockResolvedValueOnce(null);
    await refreshWaveformForTrack('t1');
    expect(hoisted.playerSetStateMock).toHaveBeenCalledWith({ waveformBins: null });
  });

  it('blanks bins when coerceWaveformBins returns null (invalid shape)', async () => {
    hoisted.playerSnapshot.currentTrack = { id: 't1' };
    hoisted.invokeMock.mockResolvedValueOnce({ bins: 'garbage' });
    hoisted.coerceWaveformBinsMock.mockReturnValueOnce(null);
    await refreshWaveformForTrack('t1');
    expect(hoisted.playerSetStateMock).toHaveBeenCalledWith({ waveformBins: null });
  });

  it('applies the coerced bins on a clean fetch', async () => {
    hoisted.playerSnapshot.currentTrack = { id: 't1' };
    hoisted.invokeMock.mockResolvedValueOnce({ bins: [10, 20, 30] });
    hoisted.coerceWaveformBinsMock.mockReturnValueOnce([10, 20, 30]);
    await refreshWaveformForTrack('t1');
    expect(hoisted.playerSetStateMock).toHaveBeenCalledWith({ waveformBins: [10, 20, 30] });
  });

  it('swallows fetch errors silently (placeholder waveform stays)', async () => {
    hoisted.playerSnapshot.currentTrack = { id: 't1' };
    hoisted.invokeMock.mockRejectedValueOnce(new Error('boom'));
    await expect(refreshWaveformForTrack('t1')).resolves.toBeUndefined();
    expect(hoisted.playerSetStateMock).not.toHaveBeenCalled();
  });
});
