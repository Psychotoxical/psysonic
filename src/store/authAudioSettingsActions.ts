import { clampStoredLoudnessPreAnalysisAttenuationRefDb } from '@/lib/audio/loudnessPreAnalysisSlider';
import {
  sanitizeAutodjOverlapCapMode,
  sanitizeAutodjOverlapCapSec,
} from '@/lib/audio/autodjOverlapCap';
import { DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB } from './authStoreDefaults';
import { updateReplayGainForCurrentTrack } from './playbackEngineBridge';
import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

/**
 * Audio/playback settings. ReplayGain/normalization/loudness mode
 * toggles call `usePlayerStore.getState().updateReplayGainForCurrentTrack()`
 * so a running track's engine state catches up to the new mode without
 * waiting for the next play. The plain crossfade/gapless/hi-res/output
 * setters skip that — they don't change the gain state, only the
 * neighbouring transitions or device routing.
 */
export function createAudioSettingsActions(set: SetState): Pick<
  AuthState,
  | 'setReplayGainEnabled'
  | 'setNormalizationEngine'
  | 'setLoudnessTargetLufs'
  | 'setLoudnessPreAnalysisAttenuationDb'
  | 'resetLoudnessPreAnalysisAttenuationDbDefault'
  | 'setReplayGainMode'
  | 'setReplayGainPreGainDb'
  | 'setReplayGainFallbackDb'
  | 'setCrossfadeEnabled'
  | 'setCrossfadeSecs'
  | 'setCrossfadeTrimSilence'
  | 'setAutodjSmoothSkip'
  | 'setAutodjOverlapCapMode'
  | 'setAutodjOverlapCapSec'
  | 'setGaplessEnabled'
  | 'setEnableHiRes'
  | 'setHiResCrossfadeResampleHz'
  | 'setAudioOutputDevice'
> {
  return {
    setReplayGainEnabled: (v) => {
      set({ replayGainEnabled: v });
      updateReplayGainForCurrentTrack();
    },
    setNormalizationEngine: (v) => {
      set({ normalizationEngine: v });
      updateReplayGainForCurrentTrack();
    },
    setLoudnessTargetLufs: (v) => {
      set({ loudnessTargetLufs: v });
      updateReplayGainForCurrentTrack();
    },
    setLoudnessPreAnalysisAttenuationDb: (v) => {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) return;
      set({ loudnessPreAnalysisAttenuationDb: clampStoredLoudnessPreAnalysisAttenuationRefDb(n) });
    },
    resetLoudnessPreAnalysisAttenuationDbDefault: () => {
      set({ loudnessPreAnalysisAttenuationDb: DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB });
      updateReplayGainForCurrentTrack();
    },
    setReplayGainMode: (v) => {
      set({ replayGainMode: v });
      updateReplayGainForCurrentTrack();
    },
    setReplayGainPreGainDb: (v) => {
      set({ replayGainPreGainDb: v });
      updateReplayGainForCurrentTrack();
    },
    setReplayGainFallbackDb: (v) => {
      set({ replayGainFallbackDb: v });
      updateReplayGainForCurrentTrack();
    },
    setCrossfadeEnabled: (v) => set({ crossfadeEnabled: v }),
    setCrossfadeSecs: (v) => set({ crossfadeSecs: v }),
    setCrossfadeTrimSilence: (v) => set({ crossfadeTrimSilence: v }),
    setAutodjSmoothSkip: (v) => set({ autodjSmoothSkip: v }),
    setAutodjOverlapCapMode: (v) => set({ autodjOverlapCapMode: sanitizeAutodjOverlapCapMode(v) }),
    setAutodjOverlapCapSec: (v) => set({ autodjOverlapCapSec: sanitizeAutodjOverlapCapSec(v) }),
    setGaplessEnabled: (v) => set({ gaplessEnabled: v }),
    setEnableHiRes: (v) => set({ enableHiRes: v }),
    setHiResCrossfadeResampleHz: (v) => set({ hiResCrossfadeResampleHz: v }),
    setAudioOutputDevice: (v) => set({ audioOutputDevice: v }),
  };
}
