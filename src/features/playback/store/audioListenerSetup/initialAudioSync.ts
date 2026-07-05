import { audioSetCrossfade, audioSetDevice, audioSetGapless, audioSetVolume } from '@/lib/api/audio';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '@/lib/audio/loudnessPreAnalysisSlider';
import { useAuthStore } from '@/store/authStore';
import { emitNormalizationDebug } from '@/features/playback/store/normalizationDebug';
import { invokeAudioSetNormalizationDeduped } from '@/features/playback/store/normalizationIpcDedupe';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { refreshLoudnessForTrack } from '@/features/playback/store/loudnessRefresh';
import { refreshWaveformForTrack } from '@/features/playback/store/waveformRefresh';

/**
 * One-shot startup sync: pushes the persisted audio settings to the Rust engine
 * and primes waveform / loudness caches for the boot track. No cleanup needed.
 */
export function runInitialAudioSync(): void {
  // Sync loved tracks cache on startup.
  usePlayerStore.getState().syncNetworkLovedTracks();

  // Initial sync of audio settings to Rust engine on startup.
  const { crossfadeEnabled, crossfadeSecs, gaplessEnabled, audioOutputDevice } = useAuthStore.getState();
  const { volume } = usePlayerStore.getState();
  audioSetVolume({ volume }).catch(() => {});
  audioSetCrossfade({ enabled: crossfadeEnabled, secs: crossfadeSecs }).catch(() => {});
  audioSetGapless({ enabled: gaplessEnabled }).catch(() => {});
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
    audioSetDevice({ deviceName: audioOutputDevice }).catch(() => {});
  }
}
