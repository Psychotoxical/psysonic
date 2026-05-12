import { useAuthStore } from './authStore';
import { resolveReplayGainDb } from '../utils/resolveReplayGainDb';
import type { PlayerState, Track } from './playerStore';

/**
 * Compute the normalization fields that should land in the next state commit
 * when the runtime switches tracks or rewrites the queue. Three branches:
 *
 *  - **loudness** — clear the visible dB until the engine pushes a real
 *    `audio:normalization-state` event back; surface the user's target LUFS.
 *  - **replaygain (enabled)** — derive the dB from track/album tags via
 *    `resolveReplayGainDb`, add the pre-gain, fall back to the configured
 *    fallback when no tag is available.
 *  - **off** (or replaygain disabled) — everything null, engine `'off'`.
 */
export function deriveNormalizationSnapshot(
  track: Track,
  queue: Track[],
  queueIndex: number,
): Pick<
  PlayerState,
  'normalizationNowDb' | 'normalizationTargetLufs' | 'normalizationEngineLive'
> {
  const auth = useAuthStore.getState();
  const engine = auth.normalizationEngine;
  if (engine === 'loudness') {
    const target = auth.loudnessTargetLufs;
    return {
      // Clears stale UI until `audio:normalization-state` / refresh catches up.
      normalizationNowDb: null,
      normalizationTargetLufs: target,
      normalizationEngineLive: 'loudness',
    };
  }
  if (engine === 'replaygain' && auth.replayGainEnabled) {
    const prev = queueIndex > 0 ? queue[queueIndex - 1] : null;
    const next = queueIndex + 1 < queue.length ? queue[queueIndex + 1] : null;
    const resolved = resolveReplayGainDb(track, prev, next, true, auth.replayGainMode);
    const nowDb = resolved != null ? (resolved + auth.replayGainPreGainDb) : auth.replayGainFallbackDb;
    return {
      normalizationNowDb: nowDb,
      normalizationTargetLufs: null,
      normalizationEngineLive: 'replaygain',
    };
  }
  return {
    normalizationNowDb: null,
    normalizationTargetLufs: null,
    normalizationEngineLive: 'off',
  };
}
