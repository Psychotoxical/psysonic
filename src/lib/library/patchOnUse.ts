import { libraryPatchTrack } from '@/lib/api/library';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';

type TrackPatch = {
  /** ms epoch when starred, or `null` to clear (unstar). */
  starredAt?: number | null;
  userRating?: number | null;
  playCount?: number | null;
  /** ms epoch of the last play. */
  playedAt?: number | null;
};

/** Optional metadata on star/unstar (album/artist); not mirrored into the local index. */
export type StarPatchMeta = {
  /** Owning saved-server profile (cross-server favorites / `?server=` detail). */
  serverId?: string;
  name?: string;
  artist?: string;
  artistId?: string;
  coverArtId?: string;
  year?: number;
  albumCount?: number;
};

/**
 * Patch-on-use (spec §6.5 / F3): after a successful star / rating / scrobble on a
 * **track**, mirror the change into the local library index. Skipped when the index
 * is off; Rust no-ops when no row exists. Fire-and-forget.
 *
 * Album/artist stars are server-only on browse (no stub rows, no `artist.starred_at`).
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
