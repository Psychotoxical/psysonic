import { libraryPatchTrack } from '../../api/library';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';

type TrackPatch = {
  /** ms epoch when starred, or `null` to clear (unstar). */
  starredAt?: number | null;
  userRating?: number | null;
  playCount?: number | null;
  /** ms epoch of the last play. */
  playedAt?: number | null;
};

/**
 * Patch-on-use (spec §6.5 / F3): after a successful star / rating / scrobble,
 * mirror the change into the local library index so its reads (browse F1,
 * advanced search F2) reflect the action immediately — no stale list after a
 * rate, no full resync. Skipped when the index is off for the server; the Rust
 * command additionally no-ops when no row exists / the id is not a track.
 * Fire-and-forget: never throws, never blocks the originating network action.
 */
export function patchLibraryTrackOnUse(
  serverId: string | null | undefined,
  trackId: string,
  patch: TrackPatch,
): void {
  if (!serverId || !trackId) return;
  if (!useLibraryIndexStore.getState().isIndexEnabled(serverId)) return;
  void libraryPatchTrack({ serverId, trackId, patch }).catch(() => {});
}
