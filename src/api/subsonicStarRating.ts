import { api, libraryFilterParams } from './subsonicClient';
import { invalidateEntityUserRatingCaches } from './subsonicRatings';
import { useAuthStore } from '../store/authStore';
import { patchLibraryTrackOnUse, type StarPatchMeta } from '../utils/library/patchOnUse';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import {
  invalidateStarredAlbumBrowse,
  refreshStarredAlbumIndexFromServer,
} from '../utils/library/starredAlbumIndexSync';
import type {
  EntityRatingSupportLevel,
  StarredResults,
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicSong,
} from './subsonicTypes';

export async function getStarred(): Promise<StarredResults> {
  const data = await api<{
    starred2: {
      artist?: SubsonicArtist[];
      album?: SubsonicAlbum[];
      song?: SubsonicSong[];
    }
  }>('getStarred2.view', { ...libraryFilterParams() });
  const r = data.starred2 ?? {};
  return { artists: r.artist ?? [], albums: r.album ?? [], songs: r.song ?? [] };
}

export async function star(
  id: string,
  type: 'song' | 'album' | 'artist' = 'album',
  _meta?: StarPatchMeta,
): Promise<void> {
  const params: Record<string, string> = {};
  if (type === 'song') params.id = id;
  if (type === 'album') params.albumId = id;
  if (type === 'artist') params.artistId = id;
  await api('star.view', params);
  const serverId = useAuthStore.getState().activeServerId;
  if (type === 'song') {
    patchLibraryTrackOnUse(serverId, id, { starredAt: Date.now() });
  } else if (type === 'album' && serverId) {
    invalidateStarredAlbumBrowse(serverId);
    const indexEnabled = useLibraryIndexStore.getState().isIndexEnabled(serverId);
    void refreshStarredAlbumIndexFromServer(serverId, indexEnabled).catch(() => {});
  }
}

export async function unstar(
  id: string,
  type: 'song' | 'album' | 'artist' = 'album',
  _meta?: StarPatchMeta,
): Promise<void> {
  const params: Record<string, string> = {};
  if (type === 'song') params.id = id;
  if (type === 'album') params.albumId = id;
  if (type === 'artist') params.artistId = id;
  await api('unstar.view', params);
  const serverId = useAuthStore.getState().activeServerId;
  if (type === 'song') {
    patchLibraryTrackOnUse(serverId, id, { starredAt: null });
  } else if (type === 'album' && serverId) {
    invalidateStarredAlbumBrowse(serverId);
    const indexEnabled = useLibraryIndexStore.getState().isIndexEnabled(serverId);
    void refreshStarredAlbumIndexFromServer(serverId, indexEnabled).catch(() => {});
  }
}

export async function setRating(id: string, rating: number): Promise<void> {
  await api('setRating.view', { id, rating });
  // No-op in Rust when `id` is an album/artist (no track row matches).
  patchLibraryTrackOnUse(useAuthStore.getState().activeServerId, id, { userRating: rating });
  // Cached song lists keyed by rating (e.g. Tracks → Highly Rated rail) become
  // stale immediately. `invalidateEntityUserRatingCaches` is static-imported:
  // mix paths already pull `subsonicRatings` (e.g. mixRatingFilter), so a
  // dynamic import would not split chunks and only triggered INEFFECTIVE_DYNAMIC_IMPORT.
  // Navidrome browse stays lazy to keep this module free of that dependency when unused.
  void import('./navidromeBrowse').then(m => m.ndInvalidateSongsCache()).catch(() => {});
  invalidateEntityUserRatingCaches(id);
}

/**
 * Probe server for OpenSubsonic extensions. When `openSubsonic: true`, we treat album/artist
 * rating as supported (same `setRating.view` + entity id); otherwise track-only.
 */
export async function probeEntityRatingSupport(): Promise<EntityRatingSupportLevel> {
  try {
    const data = await api<{ openSubsonic?: boolean; openSubsonicExtensions?: unknown[] }>(
      'getOpenSubsonicExtensions.view',
      {},
      8000,
    );
    if (data.openSubsonic === true) return 'full';
    if (Array.isArray(data.openSubsonicExtensions)) return 'full';
    return 'track_only';
  } catch {
    return 'track_only';
  }
}
