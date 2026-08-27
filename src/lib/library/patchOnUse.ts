import { libraryPatchTrack, libraryPatchAlbum } from '@/lib/api/library';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';

type TrackPatch = {
  /** ms epoch when starred, or `null` to clear (unstar). */
  starredAt?: number | null;
  userRating?: number | null;
  /**
   * The server's own tally, never a locally derived one — a count that mixes
   * units cannot be reconciled once stored (see `scrobbleSong`).
   */
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
 * Whether a patch for this server would reach anything.
 *
 * For callers that have to *fetch* something before they can patch: without this
 * they pay for the request and hand the result to a no-op. The index check lives
 * here rather than at the call site so the store stays imported in one place.
 */
export function libraryPatchReachesIndex(serverId: string | null | undefined): boolean {
  if (!serverId) return false;
  return useLibraryIndexStore.getState().isIndexEnabled(serverId);
}

/**
 * Patch-on-use (spec §6.5 / F3): after a successful star / rating / scrobble on a
 * **track**, mirror the change into the local library index. Skipped when the index
 * is off; Rust no-ops when no row exists. Fire-and-forget.
 *
 * **Album** favorites use {@link patchLibraryAlbumOnUse} (`album.starred_at`).
 * Artist stars remain server-only on browse (no `artist.starred_at` column).
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

/** Mirror album favorite toggles into `album.starred_at` (UPDATE only). */
export function patchLibraryAlbumOnUse(
  serverId: string | null | undefined,
  albumId: string,
  patch: { starredAt?: number | null },
): void {
  if (!serverId || !albumId) return;
  if (!useLibraryIndexStore.getState().isIndexEnabled(serverId)) return;
  void libraryPatchAlbum({ serverId, albumId, patch }).catch(() => {});
}

/**
 * After a successful `#getAlbum`, mirror server-owned album favorite into the
 * local index. Album user ratings stay server-only (detail reconcile).
 */
export function mirrorAlbumMetadataFromServerOnUse(
  serverId: string | null | undefined,
  albumId: string,
  album: {
    starred?: string | null;
  },
): void {
  if (!('starred' in album)) return;
  const patch: { starredAt?: number | null } = {};
  if (!album.starred) {
    patch.starredAt = null;
  } else {
    const parsed = Date.parse(album.starred);
    patch.starredAt = Number.isFinite(parsed) ? parsed : Date.now();
  }
  patchLibraryAlbumOnUse(serverId, albumId, patch);
}
