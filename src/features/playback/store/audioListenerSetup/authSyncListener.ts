import { audioSetCrossfade, audioSetGapless } from '@/lib/api/audio';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '@/lib/audio/loudnessPreAnalysisSlider';
import { useAuthStore } from '@/store/authStore';
import { onAnalysisStorageChanged } from '@/store/analysisSync';
import { emitNormalizationDebug } from '@/features/playback/store/normalizationDebug';
import { invokeAudioSetNormalizationDeduped } from '@/features/playback/store/normalizationIpcDedupe';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { clearLoudnessCacheStateForTrackId } from '@/features/playback/store/loudnessGainCache';
import { refreshLoudnessForTrack } from '@/features/playback/store/loudnessRefresh';
import { refreshWaveformForTrack } from '@/features/playback/store/waveformRefresh';
import { bumpWaveformRefreshGen } from '@/features/playback/store/waveformRefreshGen';

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
    audioSetCrossfade({
      enabled: state.crossfadeEnabled,
      secs: state.crossfadeSecs,
    }).catch(() => {});
    audioSetGapless({ enabled: state.gaplessEnabled }).catch(() => {});
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
