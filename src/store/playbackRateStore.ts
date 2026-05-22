import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import {
  clampPlaybackPitch,
  clampPlaybackSpeed,
  DEFAULT_PLAYBACK_STRATEGY,
  effectivePlaybackPitch,
  type PlaybackStrategy,
} from '../utils/audio/playbackRateHelpers';
import { isOrbitPlaybackSyncActive } from '../utils/orbit';

interface PlaybackRateState {
  enabled: boolean;
  strategy: PlaybackStrategy;
  speed: number;
  pitchSemitones: number;

  setEnabled: (v: boolean) => void;
  setStrategy: (s: PlaybackStrategy) => void;
  setSpeed: (speed: number) => void;
  setPitchSemitones: (semitones: number) => void;
  applyPresetSpeed: (speed: number) => void;
  syncToRust: () => void;
}

function syncPlaybackRate(state: Pick<PlaybackRateState, 'enabled' | 'strategy' | 'speed' | 'pitchSemitones'>) {
  // Orbit sync assumes 1.0× wall-clock playback; suppress DSP without mutating prefs.
  const effectiveEnabled = state.enabled && !isOrbitPlaybackSyncActive();
  invoke('audio_set_playback_rate', {
    enabled: effectiveEnabled,
    strategy: state.strategy,
    speed: state.speed,
    pitchSemitones: state.pitchSemitones,
  }).catch(() => {});
}

export const usePlaybackRateStore = create<PlaybackRateState>()(
  persist(
    (set, get) => ({
      enabled: false,
      strategy: DEFAULT_PLAYBACK_STRATEGY,
      speed: 1.0,
      pitchSemitones: 0,

      setEnabled: (v) => {
        set({ enabled: v });
        syncPlaybackRate(get());
      },

      setStrategy: (strategy) => {
        set({ strategy });
        syncPlaybackRate(get());
      },

      setSpeed: (speed) => {
        const clamped = clampPlaybackSpeed(speed);
        set({ speed: clamped });
        syncPlaybackRate(get());
      },

      setPitchSemitones: (semitones) => {
        const clamped = clampPlaybackPitch(semitones);
        set({ pitchSemitones: clamped });
        syncPlaybackRate(get());
      },

      applyPresetSpeed: (speed) => {
        const clamped = clampPlaybackSpeed(speed);
        set({ speed: clamped });
        syncPlaybackRate(get());
      },

      syncToRust: () => {
        syncPlaybackRate(get());
      },
    }),
    {
      name: 'psysonic-playback-rate',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        enabled: s.enabled,
        strategy: s.strategy,
        speed: s.speed,
        pitchSemitones: s.pitchSemitones,
      }),
    },
  ),
);
