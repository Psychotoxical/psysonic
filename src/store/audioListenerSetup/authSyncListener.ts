import { invoke } from '@tauri-apps/api/core';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '../../utils/loudnessPreAnalysisSlider';
import { useAuthStore } from '../authStore';
import { onAnalysisStorageChanged } from '../analysisSync';
import { emitNormalizationDebug } from '../normalizationDebug';
import { invokeAudioSetNormalizationDeduped } from '../normalizationIpcDedupe';
import { usePlayerStore } from '../playerStore';
import { clearLoudnessCacheStateForTrackId } from '../loudnessGainCache';
import { refreshLoudnessForTrack } from '../loudnessRefresh';
import { refreshWaveformForTrack } from '../waveformRefresh';
import { bumpWaveformRefreshGen } from '../waveformRefreshGen';

/**
 * Keeps the Rust audio engine in sync whenever the auth store changes
 * (crossfade / gapless / normalization), plus a cross-tab analysis-storage
 * listener that refreshes waveform + loudness for the current track. Returns a
 * cleanup function.
 */
export function setupAuthSync(): () => void {
  const normCfg = useAuthStore.getState();
  let prevNormEngine = normCfg.normalizationEngine;
  let prevNormTarget = normCfg.loudnessTargetLufs;
  let prevPreAnalysis = normCfg.loudnessPreAnalysisAttenuationDb;
  const unsubAuth = useAuthStore.subscribe((state) => {
    invoke('audio_set_crossfade', {
      enabled: state.crossfadeEnabled,
      secs: state.crossfadeSecs,
    }).catch(() => {});
    invoke('audio_set_gapless', { enabled: state.gaplessEnabled }).catch(() => {});
    const normChanged =
      state.normalizationEngine !== prevNormEngine
      || state.loudnessTargetLufs !== prevNormTarget
      || state.loudnessPreAnalysisAttenuationDb !== prevPreAnalysis;
    if (!normChanged) return;
    const onlyPreAnalysisChanged =
      state.normalizationEngine === prevNormEngine
      && state.loudnessTargetLufs === prevNormTarget
      && state.loudnessPreAnalysisAttenuationDb !== prevPreAnalysis;
    const targetLufsChanged =
      state.normalizationEngine === 'loudness'
      && state.loudnessTargetLufs !== prevNormTarget;
    prevNormEngine = state.normalizationEngine;
    prevNormTarget = state.loudnessTargetLufs;
    prevPreAnalysis = state.loudnessPreAnalysisAttenuationDb;
    usePlayerStore.setState({
      normalizationEngineLive: state.normalizationEngine,
      normalizationTargetLufs: state.normalizationEngine === 'loudness' ? state.loudnessTargetLufs : null,
      normalizationNowDb: state.normalizationEngine === 'loudness'
        ? usePlayerStore.getState().normalizationNowDb
        : null,
      normalizationDbgSource: 'auth:normalization-changed',
    });
    emitNormalizationDebug('auth:normalization-changed', {
      engine: state.normalizationEngine,
      targetLufs: state.loudnessTargetLufs,
      currentTrackId: usePlayerStore.getState().currentTrack?.id ?? null,
    });
    invokeAudioSetNormalizationDeduped({
      engine: state.normalizationEngine,
      targetLufs: state.loudnessTargetLufs,
      preAnalysisAttenuationDb: effectiveLoudnessPreAnalysisAttenuationDb(
        state.loudnessPreAnalysisAttenuationDb,
        state.loudnessTargetLufs,
      ),
    });
    if (state.normalizationEngine === 'loudness') {
      const currentId = usePlayerStore.getState().currentTrack?.id;
      if (onlyPreAnalysisChanged) {
        usePlayerStore.getState().updateReplayGainForCurrentTrack();
      } else if (currentId) {
        if (targetLufsChanged) {
          clearLoudnessCacheStateForTrackId(currentId);
        }
        void refreshLoudnessForTrack(currentId).finally(() => {
          usePlayerStore.getState().updateReplayGainForCurrentTrack();
        });
      }
    } else {
      usePlayerStore.getState().updateReplayGainForCurrentTrack();
    }
  });
  const unsubAnalysisSync = onAnalysisStorageChanged(detail => {
    const currentId = usePlayerStore.getState().currentTrack?.id;
    if (!currentId) return;
    if (detail.trackId && detail.trackId !== currentId) return;
    bumpWaveformRefreshGen(currentId);
    void refreshWaveformForTrack(currentId);
    void refreshLoudnessForTrack(currentId);
  });

  return () => {
    unsubAuth();
    unsubAnalysisSync();
  };
}
