import { api, apiForServer, libraryFilterParams, libraryFilterParamsForServer } from '@/lib/api/subsonicClient';
import { invalidateEntityUserRatingCaches } from '@/lib/api/subsonicRatings';
import { useAuthStore } from '@/store/authStore';
import { patchLibraryTrackOnUse, type StarPatchMeta } from '@/lib/library/patchOnUse';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import {
  invalidateStarredAlbumBrowse,
  refreshStarredAlbumIndexFromServer,
} from '@/lib/library/starredAlbumIndexSync';
import type {
  EntityRatingSupportLevel,
  StarredResults,
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicSong,
} from '@/lib/api/subsonicTypes';

function parseStarred2Response(data: {
  starred2?: {
    artist?: SubsonicArtist[];
    album?: SubsonicAlbum[];
    song?: SubsonicSong[];
  };
}): StarredResults {
  const r = data.starred2 ?? {};
  return { artists: r.artist ?? [], albums: r.album ?? [], songs: r.song ?? [] };
}

export async function getStarred(): Promise<StarredResults> {
  const data = await api<{
    starred2: {
      artist?: SubsonicArtist[];
      album?: SubsonicAlbum[];
      song?: SubsonicSong[];
    }
  }>('getStarred2.view', { ...libraryFilterParams() });
  return parseStarred2Response(data);
}

/** Starred entities for an explicit saved server (not necessarily the active one). */
export async function getStarredForServer(serverId: string): Promise<StarredResults> {
  const data = await apiForServer<{
    starred2: {
      artist?: SubsonicArtist[];
      album?: SubsonicAlbum[];
      song?: SubsonicSong[];
    };
  }>(serverId, 'getStarred2.view', { ...libraryFilterParamsForServer(serverId) });
  return parseStarred2Response(data);
}

function resolveStarServerId(meta?: StarPatchMeta): string | null {
  return meta?.serverId ?? useAuthStore.getState().activeServerId;
}

async function starApi(
  serverId: string | null | undefined,
  endpoint: string,
  params: Record<string, string>,
): Promise<void> {
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!sid) throw new Error('No server for star API');
  if (sid === useAuthStore.getState().activeServerId) {
    await api(endpoint, params);
  } else {
    await apiForServer(sid, endpoint, params);
  }
}

export async function star(
  id: string,
  type: 'song' | 'album' | 'artist' = 'album',
  meta?: StarPatchMeta,
): Promise<void> {
  const params: Record<string, string> = {};
  if (type === 'song') params.id = id;
  if (type === 'album') params.albumId = id;
  if (type === 'artist') params.artistId = id;
  const serverId = resolveStarServerId(meta);
  await starApi(serverId, 'star.view', params);
  if (type === 'song') {
    patchLibraryTrackOnUse(serverId, id, { starredAt: Date.now() });
  } else if (type === 'album' && serverId) {
    invalidateStarredAlbumBrowse(serverId);
    const indexEnabled = useLibraryIndexStore.getState().isIndexEnabled(serverId);
    void refreshStarredAlbumIndexFromServer(serverId, indexEnabled).catch(() => {});
  }
  void import('@/features/offline')
    .then(m => m.onFavoritesOfflineStarChange(id, type, true, serverId ?? undefined))
    .catch(() => {});
}

export async function unstar(
  id: string,
  type: 'song' | 'album' | 'artist' = 'album',
  meta?: StarPatchMeta,
): Promise<void> {
  const params: Record<string, string> = {};
  if (type === 'song') params.id = id;
  if (type === 'album') params.albumId = id;
  if (type === 'artist') params.artistId = id;
  const serverId = resolveStarServerId(meta);
  await starApi(serverId, 'unstar.view', params);
  if (type === 'song') {
    patchLibraryTrackOnUse(serverId, id, { starredAt: null });
  } else if (type === 'album' && serverId) {
    invalidateStarredAlbumBrowse(serverId);
    const indexEnabled = useLibraryIndexStore.getState().isIndexEnabled(serverId);
    void refreshStarredAlbumIndexFromServer(serverId, indexEnabled).catch(() => {});
  }
  void import('@/features/offline')
    .then(m => m.onFavoritesOfflineStarChange(id, type, false, serverId ?? undefined))
    .catch(() => {});
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
  void import('@/lib/api/navidromeBrowse').then(m => m.ndInvalidateSongsCache()).catch(() => {});
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
