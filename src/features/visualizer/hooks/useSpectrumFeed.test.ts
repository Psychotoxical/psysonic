import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  type PlayerSnapshot = {
    currentRadio: { id: string } | null;
    isPlaying: boolean;
  };
  const playerState: PlayerSnapshot = { currentRadio: null, isPlaying: true };
  const playerListeners = new Set<(
    state: PlayerSnapshot,
    previous: PlayerSnapshot,
  ) => void>();
  const playerStore = {
    getState: vi.fn(() => playerState),
    subscribe: vi.fn((listener: (state: PlayerSnapshot, previous: PlayerSnapshot) => void) => {
      playerListeners.add(listener);
      return () => playerListeners.delete(listener);
    }),
  };

  return {
    listenMock: vi.fn(),
    setActiveMock: vi.fn(async () => undefined),
    getRadioSpectrumAnalyserMock: vi.fn<() => AnalyserNode | null>(() => null),
    radioSpectrumAvailable: false,
    radioSpectrumListeners: new Set<() => void>(),
    playerState,
    playerListeners,
    playerStore,
    setPlayerState(next: Partial<PlayerSnapshot>) {
      const previous = { ...playerState };
      Object.assign(playerState, next);
      for (const listener of playerListeners) listener(playerState, previous);
    },
    setRadioSpectrumAvailable(available: boolean) {
      this.radioSpectrumAvailable = available;
      for (const listener of this.radioSpectrumListeners) listener();
    },
  };
});

vi.mock('@tauri-apps/api/event', () => ({ listen: hoisted.listenMock }));
vi.mock('@/lib/api/audio', () => ({ audioSpectrumSetActive: hoisted.setActiveMock }));
vi.mock('@/features/playback', () => ({
  getRadioSpectrumAnalyser: hoisted.getRadioSpectrumAnalyserMock,
  getRadioSpectrumAvailability: () => hoisted.radioSpectrumAvailable,
  subscribeRadioSpectrumAvailability: (listener: () => void) => {
    hoisted.radioSpectrumListeners.add(listener);
    return () => hoisted.radioSpectrumListeners.delete(listener);
  },
  usePlayerStore: hoisted.playerStore,
}));

import { useSpectrumFeed } from './useSpectrumFeed';
import {
  _resetSpectrumFeedForTest,
  _spectrumFeedRefCountForTest,
} from '@/features/visualizer/utils/spectrumSubscription';
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

function makeRadioAnalyser(level = 255): AnalyserNode {
  return {
    frequencyBinCount: 1024,
    fftSize: 2048,
    context: { sampleRate: 48_000 },
    getByteFrequencyData: vi.fn((target: Uint8Array) => target.fill(level)),
    getByteTimeDomainData: vi.fn((target: Uint8Array) => target.fill(128)),
  } as unknown as AnalyserNode;
}

const PARAMS = { fps: 60, responsiveness: 0.65 };

describe('useSpectrumFeed', () => {
  let emit: (payload: SpectrumPayload) => void;
  let unlisten: ReturnType<typeof vi.fn>;
  let now = 0;

  beforeEach(() => {
    _resetSpectrumFeedForTest();
    hoisted.setActiveMock.mockClear();
    hoisted.listenMock.mockClear();
    hoisted.getRadioSpectrumAnalyserMock.mockReset();
    hoisted.getRadioSpectrumAnalyserMock.mockReturnValue(null);
    hoisted.playerStore.getState.mockClear();
    hoisted.playerStore.subscribe.mockClear();
    hoisted.playerListeners.clear();
    hoisted.radioSpectrumListeners.clear();
    hoisted.radioSpectrumAvailable = false;
    hoisted.playerState.currentRadio = null;
    hoisted.playerState.isPlaying = true;
    now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    unlisten = vi.fn();

    hoisted.listenMock.mockImplementation(
      async (_event: string, cb: (e: { payload: unknown }) => void) => {
        emit = (payload) => cb({ payload });
        return unlisten;
      },
    );
  });

  it('draws the newest frame at 60 fps instead of lagging a frame behind', async () => {
    const { result } = renderHook(() => useSpectrumFeed(true, PARAMS));
    await vi.waitFor(() => expect(hoisted.listenMock).toHaveBeenCalled());

    now = 1_000;
    emit(frameAt(0.2));
    now = 1_016;
    emit(frameAt(0.9));
    result.current.current.sample(now);

    expect(result.current.current.frame.bands[0]).toBeCloseTo(0.9, 2);
  });

  it('still interpolates when frames arrive slower than the display', async () => {
    const { result } = renderHook(() => useSpectrumFeed(true, { ...PARAMS, fps: 15 }));
    await vi.waitFor(() => expect(hoisted.listenMock).toHaveBeenCalled());

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
    await vi.waitFor(() => expect(hoisted.listenMock).toHaveBeenCalled());

    now = 1_000;
    emit(frameAt(0.5));
    now = 1_016;
    emit(frameAt(0.5));
    result.current.current.sample(now);
    expect(result.current.current.hasSignal).toBe(true);
  });

  it('wakes a quiescent renderer when a fresh native frame arrives', async () => {
    const { result } = renderHook(() => useSpectrumFeed(true, PARAMS));
    await vi.waitFor(() => expect(hoisted.listenMock).toHaveBeenCalled());
    const wake = vi.fn();
    const unsubscribe = result.current.current.subscribe(wake);

    emit(frameAt(0.5));
    expect(wake).toHaveBeenCalledTimes(1);

    unsubscribe();
    emit(frameAt(0.6));
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('fades out by elapsed time and quiesces when frames stop', async () => {
    const { result } = renderHook(() => useSpectrumFeed(true, PARAMS));
    await vi.waitFor(() => expect(hoisted.listenMock).toHaveBeenCalled());

    now = 1_000;
    emit(frameAt(0.8));
    now = 1_016;
    emit(frameAt(0.8));
    result.current.current.sample(now);
    const lit = result.current.current.frame.bands[0]!;
    expect(lit).toBeGreaterThan(0.5);

    result.current.current.sample(now + 2_000);
    expect(result.current.current.hasSignal).toBe(false);
    expect(result.current.current.shouldAnimate).toBe(false);
    expect(result.current.current.frame.bands[0]!).toBe(0);
  });

  it('never lets a stale radio analyser overwrite fresh native playback', async () => {
    const analyser = makeRadioAnalyser();
    hoisted.getRadioSpectrumAnalyserMock.mockReturnValue(analyser);
    hoisted.playerState.currentRadio = { id: 'radio' };

    const { result } = renderHook(() => useSpectrumFeed(true, PARAMS));
    await vi.waitFor(() => expect(hoisted.listenMock).toHaveBeenCalled());

    result.current.current.sample(now);
    expect(analyser.getByteFrequencyData).toHaveBeenCalledTimes(1);

    act(() => {
      hoisted.setPlayerState({ currentRadio: null, isPlaying: true });
    });
    now = 1_016;
    emit(frameAt(0.6));
    now = 1_032;
    emit(frameAt(0.6));
    result.current.current.sample(now);

    expect(result.current.current.frame.bands[0]).toBeCloseTo(0.6, 2);
    expect(analyser.getByteFrequencyData).toHaveBeenCalledTimes(1);
  });

  it('samples radio at the requested analysis rate', async () => {
    const analyser = makeRadioAnalyser();
    hoisted.getRadioSpectrumAnalyserMock.mockReturnValue(analyser);
    hoisted.playerState.currentRadio = { id: 'radio' };

    const { result } = renderHook(() => useSpectrumFeed(true, { ...PARAMS, fps: 30 }));
    await vi.waitFor(() => expect(hoisted.listenMock).toHaveBeenCalled());

    result.current.current.sample(1_000);
    result.current.current.sample(1_016);
    result.current.current.sample(1_034);

    expect(analyser.getByteFrequencyData).toHaveBeenCalledTimes(2);
  });

  it('does not acquire the native feed while radio owns playback', async () => {
    hoisted.playerState.currentRadio = { id: 'radio' };
    renderHook(() => useSpectrumFeed(true, PARAMS));
    await vi.waitFor(() => expect(hoisted.listenMock).toHaveBeenCalled());

    expect(_spectrumFeedRefCountForTest()).toBe(0);
    expect(hoisted.setActiveMock).not.toHaveBeenCalled();
  });

  it('hands the native lease across radio source transitions', async () => {
    const { result } = renderHook(() => useSpectrumFeed(true, PARAMS));
    await vi.waitFor(() => expect(_spectrumFeedRefCountForTest()).toBe(1));

    act(() => hoisted.setPlayerState({ currentRadio: { id: 'radio' } }));
    await vi.waitFor(() => expect(_spectrumFeedRefCountForTest()).toBe(0));
    await vi.waitFor(() => expect(hoisted.setActiveMock).toHaveBeenCalledWith({
      active: false,
      ...PARAMS,
    }));

    act(() => hoisted.setPlayerState({ currentRadio: null }));
    await vi.waitFor(() => expect(_spectrumFeedRefCountForTest()).toBe(1));
    expect(hoisted.setActiveMock).toHaveBeenCalledWith({ active: true, ...PARAMS });
    expect(result.current.current.shouldAnimate).toBe(true);
  });

  it('wakes a quiescent radio renderer when the analyser attaches', async () => {
    hoisted.playerState.currentRadio = { id: 'radio' };
    const { result } = renderHook(() => useSpectrumFeed(true, PARAMS));
    await vi.waitFor(() => expect(hoisted.listenMock).toHaveBeenCalled());
    const wake = vi.fn();
    result.current.current.subscribe(wake);

    act(() => hoisted.setRadioSpectrumAvailable(true));

    expect(wake).toHaveBeenCalledTimes(1);
    expect(result.current.current.shouldAnimate).toBe(true);
  });

  it('does not poll the radio analyser while radio playback is paused', async () => {
    const analyser = makeRadioAnalyser();
    hoisted.getRadioSpectrumAnalyserMock.mockReturnValue(analyser);
    hoisted.playerState.currentRadio = { id: 'radio' };
    hoisted.playerState.isPlaying = false;

    const { result } = renderHook(() => useSpectrumFeed(true, PARAMS));
    await vi.waitFor(() => expect(hoisted.listenMock).toHaveBeenCalled());
    result.current.current.sample(1_000);

    expect(analyser.getByteFrequencyData).not.toHaveBeenCalled();
    expect(result.current.current.shouldAnimate).toBe(false);
  });

  it('updates params without replacing the listener or feed lease', async () => {
    const { rerender } = renderHook(
      ({ params }) => useSpectrumFeed(true, params),
      { initialProps: { params: PARAMS } },
    );
    await vi.waitFor(() => expect(hoisted.listenMock).toHaveBeenCalledTimes(1));
    expect(_spectrumFeedRefCountForTest()).toBe(1);
    hoisted.setActiveMock.mockClear();

    rerender({ params: { fps: 30, responsiveness: 0.9 } });
    await vi.waitFor(() => expect(hoisted.setActiveMock).toHaveBeenCalledWith({
      active: true,
      fps: 30,
      responsiveness: 0.9,
    }));

    expect(hoisted.listenMock).toHaveBeenCalledTimes(1);
    expect(hoisted.playerStore.subscribe).toHaveBeenCalledTimes(1);
    expect(unlisten).not.toHaveBeenCalled();
    expect(_spectrumFeedRefCountForTest()).toBe(1);
  });

  it('subscribes on mount and releases every listener on unmount', async () => {
    const { unmount } = renderHook(() => useSpectrumFeed(true, PARAMS));
    await vi.waitFor(() =>
      expect(hoisted.setActiveMock).toHaveBeenCalledWith({ active: true, ...PARAMS }),
    );
    expect(hoisted.playerListeners.size).toBe(1);

    hoisted.setActiveMock.mockClear();
    unmount();
    await vi.waitFor(() =>
      expect(hoisted.setActiveMock).toHaveBeenCalledWith({ active: false, ...PARAMS }),
    );
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(hoisted.playerListeners.size).toBe(0);
  });

  it('never subscribes while inactive', async () => {
    renderHook(() => useSpectrumFeed(false, PARAMS));
    await Promise.resolve();
    expect(hoisted.setActiveMock).not.toHaveBeenCalled();
    expect(hoisted.listenMock).not.toHaveBeenCalled();
    expect(hoisted.playerStore.subscribe).not.toHaveBeenCalled();
  });

  it('ignores a corrupt payload rather than blanking the display', async () => {
    const { result } = renderHook(() => useSpectrumFeed(true, PARAMS));
    await vi.waitFor(() => expect(hoisted.listenMock).toHaveBeenCalled());

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
