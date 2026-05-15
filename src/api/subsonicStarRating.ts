import { api, libraryFilterParams } from './subsonicClient';
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

export async function star(id: string, type: 'song' | 'album' | 'artist' = 'album'): Promise<void> {
  const params: Record<string, string> = {};
  if (type === 'song') params.id = id;
  if (type === 'album') params.albumId = id;
  if (type === 'artist') params.artistId = id;
  await api('star.view', params);
}

export async function unstar(id: string, type: 'song' | 'album' | 'artist' = 'album'): Promise<void> {
  const params: Record<string, string> = {};
  if (type === 'song') params.id = id;
  if (type === 'album') params.albumId = id;
  if (type === 'artist') params.artistId = id;
  await api('unstar.view', params);
}

export async function setRating(id: string, rating: number): Promise<void> {
  await api('setRating.view', { id, rating });
  // Cached song lists keyed by rating (e.g. Tracks → Highly Rated rail) become
  // stale immediately. Lazy-import to keep the module dep direction
  // subsonic ← navidromeBrowse and avoid pulling Tauri internals into shared
  // type-only consumers.
  void import('./navidromeBrowse').then(m => m.ndInvalidateSongsCache()).catch(() => {});
  void import('./subsonicRatings').then(m => m.invalidateEntityUserRatingCaches(id)).catch(() => {});
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
