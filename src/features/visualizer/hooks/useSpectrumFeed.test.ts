/**
 * Latency-focused tests for the spectrum feed.
 *
 * The original implementation always lerped between the last two arrivals,
 * which structurally held the display a full emit period behind the audio: at
 * the instant a frame landed it drew the *previous* one. These tests pin the
 * fix — at normal emit rates the newest frame is what gets drawn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const { listenMock, setActiveMock } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  setActiveMock: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@/lib/api/audio', () => ({ audioSpectrumSetActive: setActiveMock }));
vi.mock('@/features/playback', () => ({ getRadioSpectrumAnalyser: () => null }));

import { useSpectrumFeed } from './useSpectrumFeed';
import { _resetSpectrumFeedForTest } from '@/features/visualizer/utils/spectrumSubscription';
import type { SpectrumPayload } from '@/features/visualizer/utils/spectrumFrame';

/** Emit a payload whose first band sits at `level` (0..1). */
function frameAt(level: number): SpectrumPayload {
  const bands = new Array(64).fill(0);
  bands[0] = Math.round(level * 255);
  const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
  return {
    bands: b64(bands),
    peaks: b64(bands),
    waveformLeft: b64(new Array(128).fill(128)),
    waveformRight: b64(new Array(128).fill(128)),
    rms: level,
    peak: level,
    bandCount: 64,
    waveCount: 128,
    sampleRate: 48_000,
  };
}

const PARAMS = { fps: 60, responsiveness: 0.65 };

describe('useSpectrumFeed', () => {
  let emit: (payload: SpectrumPayload) => void;
  let now = 0;

  beforeEach(() => {
    _resetSpectrumFeedForTest();
    setActiveMock.mockClear();
    listenMock.mockClear();
    now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    listenMock.mockImplementation(async (_event: string, cb: (e: { payload: unknown }) => void) => {
      emit = (payload) => cb({ payload });
      return () => {};
    });
  });

  it('draws the newest frame at 60 fps instead of lagging a frame behind', async () => {
    const { result } = renderHook(() => useSpectrumFeed(true, PARAMS));
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalled());

    // Two arrivals ~16 ms apart, i.e. a normal 60 fps feed.
    now = 1_000;
    emit(frameAt(0.2));
    now = 1_016;
    emit(frameAt(0.9));

    // Sample at the very instant the second frame landed.
    result.current.current.sample(now);

    // The old lerp would have rendered 0.2 here — the previous frame.
    expect(result.current.current.frame.bands[0]).toBeCloseTo(0.9, 2);
  });

  it('still interpolates when frames arrive slower than the display', async () => {
    const { result } = renderHook(() => useSpectrumFeed(true, { ...PARAMS, fps: 15 }));
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalled());

    // ~66 ms apart: sparse enough that smoothing is worth a frame of latency.
    now = 1_000;
    emit(frameAt(0));
    now = 1_066;
    emit(frameAt(1));

    result.current.current.sample(now);
    const atArrival = result.current.current.frame.bands[0]!;
    result.current.current.sample(now + 33);
    const midway = result.current.current.frame.bands[0]!;

    expect(atArrival).toBeLessThan(0.1);
    expect(midway).toBeGreaterThan(atArrival);
    expect(midway).toBeLessThan(1);
  });

  it('reports signal while frames flow', async () => {
    const { result } = renderHook(() => useSpectrumFeed(true, PARAMS));
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalled());

    now = 1_000;
    emit(frameAt(0.5));
    now = 1_016;
    emit(frameAt(0.5));
    result.current.current.sample(now);
    expect(result.current.current.hasSignal).toBe(true);
  });

  it('fades out and drops the signal flag when frames stop', async () => {
    const { result } = renderHook(() => useSpectrumFeed(true, PARAMS));
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalled());

    now = 1_000;
    emit(frameAt(0.8));
    now = 1_016;
    emit(frameAt(0.8));
    result.current.current.sample(now);
    const lit = result.current.current.frame.bands[0]!;
    expect(lit).toBeGreaterThan(0.5);

    // Well past the staleness window.
    result.current.current.sample(now + 2_000);
    expect(result.current.current.hasSignal).toBe(false);
    expect(result.current.current.frame.bands[0]!).toBeLessThan(lit);
  });

  it('subscribes on mount and releases on unmount', async () => {
    const { unmount } = renderHook(() => useSpectrumFeed(true, PARAMS));
    await vi.waitFor(() =>
      expect(setActiveMock).toHaveBeenCalledWith({ active: true, ...PARAMS }),
    );

    setActiveMock.mockClear();
    unmount();
    await vi.waitFor(() =>
      expect(setActiveMock).toHaveBeenCalledWith({ active: false, ...PARAMS }),
    );
  });

  it('never subscribes while inactive', async () => {
    renderHook(() => useSpectrumFeed(false, PARAMS));
    await Promise.resolve();
    expect(setActiveMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
  });

  it('ignores a corrupt payload rather than blanking the display', async () => {
    const { result } = renderHook(() => useSpectrumFeed(true, PARAMS));
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalled());

    now = 1_000;
    emit(frameAt(0.7));
    now = 1_016;
    emit(frameAt(0.7));
    result.current.current.sample(now);
    const good = result.current.current.frame.bands[0]!;

    now = 1_032;
    emit({ ...frameAt(0.7), bands: '', peaks: '' });
    result.current.current.sample(now);
    expect(result.current.current.frame.bands[0]!).toBeCloseTo(good, 2);
  });
});
