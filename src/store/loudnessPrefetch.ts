import { useAuthStore } from './authStore';
import { collectLoudnessBackfillWindowTrackIds } from './loudnessBackfillWindow';
import { refreshLoudnessForTrack } from './loudnessRefresh';
import { usePlayerStore, type Track } from './playerStore';

/**
 * After a bulk enqueue (queue replace, append-many, lucky-mix) warm the
 * loudness cache for the current track + the next N entries so the
 * gapless `audio_chain_preload` payload sees a real cached gain instead
 * of the startup trim. No-op when normalization isn't on `loudness` —
 * other engines don't need the cache populated proactively.
 *
 * Calls don't sync the playing engine (`syncPlayingEngine: false`) — the
 * already-playing track is unaffected; we're only filling the cache for
 * the upcoming ones.
 */
export function prefetchLoudnessForEnqueuedTracks(
  mergedQueue: Track[],
  queueIndex: number,
): void {
  if (useAuthStore.getState().normalizationEngine !== 'loudness') return;
  const currentTrack = usePlayerStore.getState().currentTrack;
  const ids = collectLoudnessBackfillWindowTrackIds(mergedQueue, queueIndex, currentTrack);
  for (const id of ids) {
    void refreshLoudnessForTrack(id, { syncPlayingEngine: false });
  }
}
