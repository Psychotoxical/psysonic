import { effectiveLoudnessPreAnalysisAttenuationDb } from '../utils/loudnessPreAnalysisSlider';
import { loudnessGainPlaceholderUntilCacheDb } from '../utils/loudnessPlaceholder';
import { resolveReplayGainDb } from '../utils/resolveReplayGainDb';
import { useAuthStore } from './authStore';
import {
  getCachedLoudnessGain,
  hasStableLoudness,
  isReplayGainActive,
} from './loudnessGainCache';
import { deriveNormalizationSnapshot } from './normalizationSnapshot';
import { invokeAudioUpdateReplayGainDeduped } from './normalizationIpcDedupe';
import type { PlayerState } from './playerStoreTypes';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * Recompute and push fresh ReplayGain + loudness state to the engine
 * for the currently-playing track. Called when ReplayGain mode /
 * pre-gain / fallback toggles change while a track is mid-playback,
 * or when the loudness cache for the current track resolves later
 * than the initial play.
 *
 * - Re-derives the normalization snapshot (target LUFS, engine-live
 *   mode) from the current queue context.
 * - Picks a placeholder loudness gain when in loudness mode and the
 *   real cached gain isn't ready yet, so the UI's "now playing -X dB"
 *   readout doesn't drop to zero between the cache miss and the
 *   eventual cache fill.
 * - Pushes the new audio parameters to the Rust engine via the
 *   deduplicated IPC channel.
 */
export function runUpdateReplayGainForCurrentTrack(set: SetState, get: GetState): void {
  const { currentTrack, queue, queueIndex, volume } = get();
  if (!currentTrack || !currentTrack.id) return;
  const authState = useAuthStore.getState();
  const prev = queueIndex > 0 ? queue[queueIndex - 1] : null;
  const next = queueIndex + 1 < queue.length ? queue[queueIndex + 1] : null;
  const replayGainDb = resolveReplayGainDb(
    currentTrack, prev, next,
    isReplayGainActive(), authState.replayGainMode,
  );
  const replayGainPeak = isReplayGainActive()
    ? (currentTrack.replayGainPeak ?? null)
    : null;

  const normalization = deriveNormalizationSnapshot(currentTrack, queue, queueIndex);
  const cachedLoud = getCachedLoudnessGain(currentTrack.id);
  const cachedLoudDb = Number.isFinite(cachedLoud) ? cachedLoud! : null;
  const haveStableLoud = hasStableLoudness(currentTrack.id);
  const preEffForNorm = effectiveLoudnessPreAnalysisAttenuationDb(
    authState.loudnessPreAnalysisAttenuationDb,
    authState.loudnessTargetLufs,
  );
  const preAnalysisPlaceholderDb =
    normalization.normalizationEngineLive === 'loudness'
    && cachedLoudDb == null
    && !haveStableLoud
    && Number.isFinite(preEffForNorm)
      ? loudnessGainPlaceholderUntilCacheDb(
          authState.loudnessTargetLufs,
          preEffForNorm,
        )
      : null;
  set(prevState => ({
    normalizationNowDb:
      normalization.normalizationEngineLive === 'loudness'
        ? (cachedLoudDb ?? preAnalysisPlaceholderDb ?? prevState.normalizationNowDb)
        : normalization.normalizationNowDb,
    normalizationTargetLufs: normalization.normalizationTargetLufs,
    normalizationEngineLive: normalization.normalizationEngineLive,
  }));
  invokeAudioUpdateReplayGainDeduped({
    volume,
    replayGainDb,
    replayGainPeak,
    loudnessGainDb: getCachedLoudnessGain(currentTrack.id) ?? null,
    preGainDb: authState.replayGainPreGainDb,
    fallbackDb: authState.replayGainFallbackDb,
  });
}
