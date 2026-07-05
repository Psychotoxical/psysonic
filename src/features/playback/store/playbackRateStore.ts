import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { audioSetPlaybackRate } from '@/lib/api/audio';
import {
  clampPlaybackPitch,
  clampPlaybackSpeed,
  DEFAULT_PLAYBACK_STRATEGY,
  effectivePlaybackPitch,
  engineStrategy,
  type PlaybackStrategy,
} from '@/features/playback/utils/audio/playbackRateHelpers';
import {
  restartPlaybackForRateChange,
  shouldRestartPlaybackForRateChange,
  type PlaybackRateSnapshot,
} from '@/features/playback/utils/audio/playbackRateRestart';
import { isOrbitPlaybackSyncActive } from '@/store/orbitRuntime';

interface PlaybackRateState extends PlaybackRateSnapshot {
  /** UI-only: smaller slider steps (Advanced). Not sent to the engine. */
  fineStep: boolean;

  setEnabled: (v: boolean) => void;
  setStrategy: (s: PlaybackStrategy) => void;
  setSpeed: (speed: number) => void;
  setPitchSemitones: (semitones: number) => void;
  applyPresetSpeed: (speed: number) => void;
  setFineStep: (v: boolean) => void;
  syncToRust: () => void;
}

function syncPlaybackRate(state: PlaybackRateSnapshot, prev?: PlaybackRateSnapshot) {
  // Orbit sync assumes 1.0× wall-clock playback; suppress DSP without mutating prefs.
  const effectiveEnabled = state.enabled && !isOrbitPlaybackSyncActive();
  audioSetPlaybackRate({
    enabled: effectiveEnabled,
    strategy: engineStrategy(state.strategy),
    speed: state.speed,
    pitchSemitones: effectivePlaybackPitch(state.strategy, state.pitchSemitones),
  }).catch(() => {});

  if (prev && shouldRestartPlaybackForRateChange(prev, state)) {
    restartPlaybackForRateChange();
  }
}

export const usePlaybackRateStore = create<PlaybackRateState>()(
  persist(
    (set, get) => ({
      enabled: false,
      strategy: DEFAULT_PLAYBACK_STRATEGY,
      speed: 1.0,
      pitchSemitones: 0,
      fineStep: false,

      setEnabled: (v) => {
        const prev = get();
        set({ enabled: v });
        syncPlaybackRate(get(), prev);
      },

      setStrategy: (strategy) => {
        const prev = get();
        set({ strategy });
        syncPlaybackRate(get(), prev);
      },

      setSpeed: (speed) => {
        const prev = get();
        const clamped = clampPlaybackSpeed(speed);
        set({ speed: clamped });
        syncPlaybackRate(get(), prev);
      },

      setPitchSemitones: (semitones) => {
        const prev = get();
        const clamped = clampPlaybackPitch(semitones);
        set({ pitchSemitones: clamped });
        syncPlaybackRate(get(), prev);
      },

      applyPresetSpeed: (speed) => {
        const prev = get();
        const clamped = clampPlaybackSpeed(speed);
        set({ speed: clamped });
        syncPlaybackRate(get(), prev);
      },

      setFineStep: (v) => set({ fineStep: v }),

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
        fineStep: s.fineStep,
      }),
    },
  ),
);
