/**
 * Silence-aware crossfade (B-head) — tiny module cache bridging the pre-buffer
 * stage and `playTrack`. During the crossfade pre-buffer window
 * (`handleAudioProgress`) we fetch the *next* track's cached waveform and derive
 * its leading-silence offset; `playTrackAction` then reads it to pass
 * `audio_play(start_secs)` so the incoming track begins on real audio.
 *
 * Kept out of the persisted Zustand store on purpose: this is ephemeral,
 * per-transition playback data, not user state.
 */

/** trackId → leading-silence seconds to skip when this track starts under crossfade. */
const leadSilenceByTrackId = new Map<string, number>();
/** trackIds we've already attempted a waveform fetch for (avoids per-tick refetch). */
const fetchedTrackIds = new Set<string>();

// Bound both maps so a long session can't grow them without limit.
const MAX_ENTRIES = 32;

function trim<T>(map: { delete: (k: string) => void; size: number; keys: () => IterableIterator<string> }): void {
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Record the lead-silence offset (seconds) computed for `trackId`. */
export function setCrossfadeLeadSilence(trackId: string, leadSilenceSec: number): void {
  if (!trackId) return;
  leadSilenceByTrackId.set(trackId, Math.max(0, leadSilenceSec));
  trim(leadSilenceByTrackId);
}

/** Read the cached lead-silence offset for `trackId` (0 when none/unknown). */
export function getCrossfadeLeadSilence(trackId: string): number {
  if (!trackId) return 0;
  return leadSilenceByTrackId.get(trackId) ?? 0;
}

/** True once we've already attempted a waveform fetch for `trackId` this window. */
export function hasFetchedCrossfadeLead(trackId: string): boolean {
  return fetchedTrackIds.has(trackId);
}

/** Mark `trackId` as fetched so the pre-buffer loop doesn't refetch every tick. */
export function markFetchedCrossfadeLead(trackId: string): void {
  if (!trackId) return;
  fetchedTrackIds.add(trackId);
  trim(fetchedTrackIds);
}

/** Test/reset hook. */
export function _resetCrossfadeTrimCacheForTest(): void {
  leadSilenceByTrackId.clear();
  fetchedTrackIds.clear();
}
