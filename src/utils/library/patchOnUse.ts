import { libraryPatchAlbum, libraryPatchArtist, libraryPatchTrack } from '../../api/library';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';

type TrackPatch = {
  /** ms epoch when starred, or `null` to clear (unstar). */
  starredAt?: number | null;
  userRating?: number | null;
  playCount?: number | null;
  /** ms epoch of the last play. */
  playedAt?: number | null;
};

/** Optional index hints when starring entities (stub row metadata). */
export type StarPatchMeta = {
  name?: string;
  artist?: string;
  artistId?: string;
  coverArtId?: string;
  year?: number;
  albumCount?: number;
};

/** @deprecated Use {@link StarPatchMeta} */
export type AlbumPatchMeta = StarPatchMeta;

type AlbumPatch = {
  starredAt?: number | null;
} & StarPatchMeta;

type ArtistPatch = {
  starredAt?: number | null;
  name?: string;
  albumCount?: number;
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

/**
 * Mirror album-level star/unstar into `album.starred_at` for Albums browse
 * (album favorites only — not track stars).
 */
export function patchLibraryAlbumOnUse(
  serverId: string | null | undefined,
  albumId: string,
  patch: AlbumPatch,
): void {
  if (!serverId || !albumId) return;
  if (!useLibraryIndexStore.getState().isIndexEnabled(serverId)) return;
  void libraryPatchAlbum({ serverId, albumId, patch }).catch(() => {});
}

/** Mirror artist-level star/unstar into `artist.starred_at` for Artists browse. */
export function patchLibraryArtistOnUse(
  serverId: string | null | undefined,
  artistId: string,
  patch: ArtistPatch,
): void {
  if (!serverId || !artistId) return;
  if (!useLibraryIndexStore.getState().isIndexEnabled(serverId)) return;
  void libraryPatchArtist({ serverId, artistId, patch }).catch(() => {});
}
