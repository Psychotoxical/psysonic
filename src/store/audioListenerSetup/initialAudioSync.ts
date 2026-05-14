import { invoke } from '@tauri-apps/api/core';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '../../utils/audio/loudnessPreAnalysisSlider';
import { useAuthStore } from '../authStore';
import { emitNormalizationDebug } from '../normalizationDebug';
import { invokeAudioSetNormalizationDeduped } from '../normalizationIpcDedupe';
import { usePlayerStore } from '../playerStore';
import { refreshLoudnessForTrack } from '../loudnessRefresh';
import { refreshWaveformForTrack } from '../waveformRefresh';

/**
 * One-shot startup sync: pushes the persisted audio settings to the Rust engine
 * and primes waveform / loudness caches for the boot track. No cleanup needed.
 */
export function runInitialAudioSync(): void {
  // Sync Last.fm loved tracks cache on startup.
  usePlayerStore.getState().syncLastfmLovedTracks();

  // Initial sync of audio settings to Rust engine on startup.
  const { crossfadeEnabled, crossfadeSecs, gaplessEnabled, audioOutputDevice } = useAuthStore.getState();
  invoke('audio_set_crossfade', { enabled: crossfadeEnabled, secs: crossfadeSecs }).catch(() => {});
  invoke('audio_set_gapless', { enabled: gaplessEnabled }).catch(() => {});
  const normCfg = useAuthStore.getState();
  usePlayerStore.setState({
    normalizationEngineLive: normCfg.normalizationEngine,
    normalizationTargetLufs: normCfg.normalizationEngine === 'loudness' ? normCfg.loudnessTargetLufs : null,
    normalizationNowDb: null,
    normalizationDbgSource: 'init:set-normalization',
  });
  emitNormalizationDebug('init:set-normalization', {
    engine: normCfg.normalizationEngine,
    targetLufs: normCfg.loudnessTargetLufs,
    currentTrackId: usePlayerStore.getState().currentTrack?.id ?? null,
  });
  invokeAudioSetNormalizationDeduped({
    engine: normCfg.normalizationEngine,
    targetLufs: normCfg.loudnessTargetLufs,
    preAnalysisAttenuationDb: effectiveLoudnessPreAnalysisAttenuationDb(
      normCfg.loudnessPreAnalysisAttenuationDb,
      normCfg.loudnessTargetLufs,
    ),
  });
  const bootTrackId = usePlayerStore.getState().currentTrack?.id;
  if (bootTrackId) {
    void refreshWaveformForTrack(bootTrackId);
  }
  if (normCfg.normalizationEngine === 'loudness') {
    const currentId = usePlayerStore.getState().currentTrack?.id;
    if (currentId) {
      void refreshLoudnessForTrack(currentId).finally(() => {
        usePlayerStore.getState().updateReplayGainForCurrentTrack();
      });
    }
  }
  if (audioOutputDevice) {
    invoke('audio_set_device', { deviceName: audioOutputDevice }).catch(() => {});
  }
}
