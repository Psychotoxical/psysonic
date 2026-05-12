/**
 * IPC dedupers — each helper collapses repeat calls within a time-bounded
 * window. The interesting behaviour is the engine-mode contribution to the
 * replay-gain dedupe key (so changing the LUFS target re-fires even when
 * the cached dB stays the same) and the null-aware number formatter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authState, invokeMock } = vi.hoisted(() => ({
  authState: {
    normalizationEngine: 'off' as 'off' | 'replaygain' | 'loudness',
    loudnessTargetLufs: -14,
    loudnessPreAnalysisAttenuationDb: 0,
  },
  invokeMock: vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('./authStore', () => ({ useAuthStore: { getState: () => authState } }));
vi.mock('../utils/loudnessPreAnalysisSlider', () => ({
  effectiveLoudnessPreAnalysisAttenuationDb: (attenuation: number) => attenuation,
}));

import {
  _resetNormalizationIpcDedupeForTest,
  invokeAudioSetNormalizationDeduped,
  invokeAudioUpdateReplayGainDeduped,
} from './normalizationIpcDedupe';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));
  invokeMock.mockClear();
  authState.normalizationEngine = 'off';
  authState.loudnessTargetLufs = -14;
  authState.loudnessPreAnalysisAttenuationDb = 0;
});

afterEach(() => {
  _resetNormalizationIpcDedupeForTest();
  vi.useRealTimers();
});

describe('invokeAudioSetNormalizationDeduped', () => {
  const payload = { engine: 'loudness', targetLufs: -14, preAnalysisAttenuationDb: 0 };

  it('passes the first call through', () => {
    invokeAudioSetNormalizationDeduped(payload);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('audio_set_normalization', payload);
  });

  it('skips a repeat with the same payload inside the 450 ms window', () => {
    invokeAudioSetNormalizationDeduped(payload);
    vi.advanceTimersByTime(449);
    invokeAudioSetNormalizationDeduped(payload);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('fires again once the 450 ms window elapses', () => {
    invokeAudioSetNormalizationDeduped(payload);
    vi.advanceTimersByTime(450);
    invokeAudioSetNormalizationDeduped(payload);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('fires when any payload field changes within the window', () => {
    invokeAudioSetNormalizationDeduped(payload);
    invokeAudioSetNormalizationDeduped({ ...payload, targetLufs: -10 });
    invokeAudioSetNormalizationDeduped({ ...payload, engine: 'replaygain' });
    invokeAudioSetNormalizationDeduped({ ...payload, preAnalysisAttenuationDb: -2 });
    expect(invokeMock).toHaveBeenCalledTimes(4);
  });
});

describe('invokeAudioUpdateReplayGainDeduped', () => {
  const payload = {
    volume: 0.8,
    replayGainDb: -6,
    replayGainPeak: 0.9,
    loudnessGainDb: -3,
    preGainDb: 0,
    fallbackDb: -6,
  };

  it('passes the first call through', () => {
    invokeAudioUpdateReplayGainDeduped(payload);
    expect(invokeMock).toHaveBeenCalledWith('audio_update_replay_gain', payload);
  });

  it('skips a repeat with the same payload inside the 250 ms window', () => {
    invokeAudioUpdateReplayGainDeduped(payload);
    vi.advanceTimersByTime(249);
    invokeAudioUpdateReplayGainDeduped(payload);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('fires again once the 250 ms window elapses', () => {
    invokeAudioUpdateReplayGainDeduped(payload);
    vi.advanceTimersByTime(250);
    invokeAudioUpdateReplayGainDeduped(payload);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('re-fires when the LUFS target changes even if the dB payload stays the same', () => {
    authState.normalizationEngine = 'loudness';
    authState.loudnessTargetLufs = -14;
    invokeAudioUpdateReplayGainDeduped(payload);
    authState.loudnessTargetLufs = -10;
    invokeAudioUpdateReplayGainDeduped(payload);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('treats null and non-finite gain values as the dedupe-string "null"', () => {
    invokeAudioUpdateReplayGainDeduped({ ...payload, replayGainDb: null });
    invokeAudioUpdateReplayGainDeduped({ ...payload, replayGainDb: Number.NaN });
    // Same dedupe-key (both serialize to "null") + same window → second call dropped.
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

describe('_resetNormalizationIpcDedupeForTest', () => {
  it('lets the next call through again after a reset', () => {
    const payload = { engine: 'off', targetLufs: -14, preAnalysisAttenuationDb: 0 };
    invokeAudioSetNormalizationDeduped(payload);
    _resetNormalizationIpcDedupeForTest();
    invokeAudioSetNormalizationDeduped(payload);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
