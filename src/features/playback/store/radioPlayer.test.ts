/**
 * Tests cover the imperative API — playRadioStream / pauseRadio /
 * resumeRadio / stopRadio / setRadioVolume / clearRadioReconnectTimer.
 * The reconnect listener loop is exercised indirectly: dispatching the
 * 'stalled' event on the audio element drives the timer + counter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const playerStateGet = vi.fn(() => ({ currentRadio: null as { id: string } | null }));
  return {
    showToastMock: vi.fn(),
    playerSetStateMock: vi.fn(),
    playerStateGet,
    eqEnabled: false,
  };
});

vi.mock('@/lib/dom/toast', () => ({ showToast: hoisted.showToastMock }));
vi.mock('@/store/eqStore', () => ({
  useEqStore: {
    getState: () => ({ enabled: hoisted.eqEnabled, gains: [], preGain: 0 }),
    subscribe: vi.fn(() => vi.fn()),
  },
}));
vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: {
    getState: hoisted.playerStateGet,
    setState: hoisted.playerSetStateMock,
  },
}));
vi.mock('@/features/playback/utils/audio/radioEqGraph', () => ({
  applyRadioEqSettings: vi.fn(),
  applyRadioOutputVolume: vi.fn(),
  isRadioEqGraphActive: vi.fn(() => false),
  resumeRadioEqContext: vi.fn(() => Promise.resolve()),
  setRadioEqMasterVolume: vi.fn(),
  shouldUseRadioEqGraph: vi.fn(() => hoisted.eqEnabled),
  tryAttachRadioEqGraph: vi.fn(() => Promise.resolve(false)),
  warmRadioEqContextFromUserGesture: vi.fn(),
}));

import {
  _radioAudioForTest,
  _resetRadioPlayerForTest,
  clearRadioReconnectTimer,
  pauseRadio,
  playRadioStream,
  resumeRadio,
  setRadioVolume,
  stopRadio,
} from '@/features/playback/store/radioPlayer';

const audio = _radioAudioForTest();
let pauseSpy: ReturnType<typeof vi.spyOn>;
let playSpy: ReturnType<typeof vi.spyOn>;
let loadSpy: ReturnType<typeof vi.spyOn>;
let pausedSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.eqEnabled = false;
  hoisted.showToastMock.mockClear();
  hoisted.playerSetStateMock.mockClear();
  hoisted.playerStateGet.mockReset();
  hoisted.playerStateGet.mockReturnValue({ currentRadio: null });
  pauseSpy = vi.spyOn(audio, 'pause').mockImplementation(() => {});
  playSpy = vi.spyOn(audio, 'play').mockResolvedValue(undefined as never);
  loadSpy = vi.spyOn(audio, 'load').mockImplementation(() => {});
  pausedSpy = vi.spyOn(audio, 'paused', 'get').mockReturnValue(false);
});

afterEach(() => {
  _resetRadioPlayerForTest();
  pauseSpy.mockRestore();
  playSpy.mockRestore();
  loadSpy.mockRestore();
  pausedSpy.mockRestore();
  vi.useRealTimers();
});

describe('playRadioStream', () => {
  it('sets src + clamped volume + calls play', async () => {
    await playRadioStream('https://stream.example/foo', 0.6);
    expect(audio.src).toContain('https://stream.example/foo');
    expect(audio.volume).toBeCloseTo(0.6);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('clamps volume above 1 to 1', async () => {
    await playRadioStream('https://x/y', 1.5);
    expect(audio.volume).toBe(1);
  });

  it('clamps volume below 0 to 0', async () => {
    await playRadioStream('https://x/y', -0.5);
    expect(audio.volume).toBe(0);
  });

  it('does not show error toast when switching station URL', async () => {
    await playRadioStream('https://x/y', 0.5);
    hoisted.showToastMock.mockClear();
    await playRadioStream('https://x/z', 0.5);
    Object.defineProperty(audio, 'error', { value: { code: 1 }, configurable: true });
    audio.dispatchEvent(new Event('error'));
    expect(hoisted.showToastMock).not.toHaveBeenCalled();
  });
});

describe('pauseRadio / resumeRadio', () => {
  it('pause cancels a pending reconnect timer (issue #779)', () => {
    hoisted.playerStateGet.mockReturnValue({ currentRadio: { id: 'r1' } });
    audio.dispatchEvent(new Event('stalled'));
    pauseRadio();
    vi.advanceTimersByTime(4000);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('pause delegates to audio.pause without touching src', async () => {
    await playRadioStream('https://x/y', 0.5);
    const before = audio.src;
    pauseRadio();
    expect(pauseSpy).toHaveBeenCalled();
    expect(audio.src).toBe(before);
  });

  it('resume delegates to audio.play', async () => {
    await resumeRadio();
    expect(playSpy).toHaveBeenCalled();
  });
});

describe('stopRadio', () => {
  it('pauses + clears src + cancels reconnect timer', async () => {
    await playRadioStream('https://x/y', 0.5);
    stopRadio();
    expect(pauseSpy).toHaveBeenCalled();
    expect(audio.getAttribute('src')).toBe('');
  });

  it('does not show an error toast if the resulting "error" event was caused by stop', () => {
    stopRadio();
    audio.dispatchEvent(new Event('error'));
    expect(hoisted.showToastMock).not.toHaveBeenCalled();
    expect(hoisted.playerSetStateMock).not.toHaveBeenCalled();
  });
});

describe('setRadioVolume', () => {
  it('sets the volume directly', () => {
    setRadioVolume(0.3);
    expect(audio.volume).toBeCloseTo(0.3);
  });

  it('clamps the volume', () => {
    setRadioVolume(2);
    expect(audio.volume).toBe(1);
    setRadioVolume(-1);
    expect(audio.volume).toBe(0);
  });
});

describe('event listeners', () => {
  it('"ended" clears radio state', () => {
    audio.dispatchEvent(new Event('ended'));
    const calls = hoisted.playerSetStateMock.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as Record<string, unknown>;
    expect(lastCall).toMatchObject({
      isPlaying: false,
      currentRadio: null,
      progress: 0,
      currentTime: 0,
    });
  });

  it('"error" (without prior stop) shows a toast + clears radio state', () => {
    audio.dispatchEvent(new Event('error'));
    expect(hoisted.showToastMock).toHaveBeenCalledWith('Radio stream error', 3000, 'error');
    const calls = hoisted.playerSetStateMock.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as Record<string, unknown>;
    expect(lastCall).toMatchObject({ isPlaying: false, currentRadio: null });
  });

  it('"stalled" schedules a reconnect attempt after 4 s', () => {
    hoisted.playerStateGet.mockReturnValue({ currentRadio: { id: 'r1' } });
    audio.dispatchEvent(new Event('stalled'));
    expect(loadSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4000);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('"stalled" suppresses second schedule when one is already pending', () => {
    hoisted.playerStateGet.mockReturnValue({ currentRadio: { id: 'r1' } });
    audio.dispatchEvent(new Event('stalled'));
    audio.dispatchEvent(new Event('stalled'));
    vi.advanceTimersByTime(4000);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('"stalled" gives up after MAX_RADIO_RECONNECTS (5) attempts', () => {
    hoisted.playerStateGet.mockReturnValue({ currentRadio: { id: 'r1' } });
    for (let i = 0; i < 5; i++) {
      audio.dispatchEvent(new Event('stalled'));
      vi.advanceTimersByTime(4000);
    }
    audio.dispatchEvent(new Event('stalled'));
    expect(hoisted.showToastMock).toHaveBeenCalledWith('Radio stream disconnected', 4000, 'error');
    const calls = hoisted.playerSetStateMock.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as Record<string, unknown>;
    expect(lastCall).toMatchObject({ isPlaying: false, currentRadio: null });
  });

  it('"playing" resets the reconnect counter (next stall starts fresh)', () => {
    hoisted.playerStateGet.mockReturnValue({ currentRadio: { id: 'r1' } });
    audio.dispatchEvent(new Event('stalled'));
    vi.advanceTimersByTime(4000);
    audio.dispatchEvent(new Event('playing'));
    loadSpy.mockClear();
    audio.dispatchEvent(new Event('stalled'));
    vi.advanceTimersByTime(4000);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('"suspend" cancels a pending reconnect', () => {
    hoisted.playerStateGet.mockReturnValue({ currentRadio: { id: 'r1' } });
    audio.dispatchEvent(new Event('stalled'));
    audio.dispatchEvent(new Event('suspend'));
    vi.advanceTimersByTime(4000);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('"stalled" while paused does not schedule a reconnect (issue #779)', () => {
    hoisted.playerStateGet.mockReturnValue({ currentRadio: { id: 'r1' } });
    const pausedGet = vi.spyOn(audio, 'paused', 'get').mockReturnValue(true);
    try {
      audio.dispatchEvent(new Event('stalled'));
      vi.advanceTimersByTime(4000);
      expect(loadSpy).not.toHaveBeenCalled();
    } finally {
      pausedGet.mockRestore();
    }
  });

  it('reconnect callback skips load+play if user paused during the 4 s wait (issue #779)', () => {
    hoisted.playerStateGet.mockReturnValue({ currentRadio: { id: 'r1' } });
    audio.dispatchEvent(new Event('stalled'));
    const pausedGet = vi.spyOn(audio, 'paused', 'get').mockReturnValue(true);
    try {
      vi.advanceTimersByTime(4000);
      expect(loadSpy).not.toHaveBeenCalled();
      expect(playSpy).not.toHaveBeenCalled();
    } finally {
      pausedGet.mockRestore();
    }
  });
});

describe('clearRadioReconnectTimer', () => {
  it('cancels a scheduled reconnect', () => {
    hoisted.playerStateGet.mockReturnValue({ currentRadio: { id: 'r1' } });
    audio.dispatchEvent(new Event('stalled'));
    clearRadioReconnectTimer();
    vi.advanceTimersByTime(10_000);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when nothing is scheduled', () => {
    expect(() => clearRadioReconnectTimer()).not.toThrow();
  });
});
