import { libraryScopeListMainstageAlbums, type LibraryScopePair } from '@/lib/api/library/scopeReads';
import { albumToAlbum } from '@/lib/library/advancedSearchLocal';
import type { GenreAlbumCountRow } from '@/lib/api/library/dto';
import { describeMultiServerError, emitMultiServerDebug } from '@/lib/library/multiServerDebug';

/**
 * Reads the new-releases feed out of the local index.
 *
 * `includeGenreCounts` defaults to **off**, and deliberately so: the count query
 * dominates the request — roughly 3.2s against 35ms for the feed itself on a
 * large library — while every browse read shares a single connection, so one
 * unnecessary count stalls whatever the app does next. Only the caller that
 * actually renders a genre filter should ask for it, and only when it is about
 * to use the result. Both callers that got this wrong (the sidebar unread badge,
 * and this feed's own pagination) did so by leaving the argument off.
 */
export async function loadLocalNewReleases(
  anchorServerId: string,
  scopes: LibraryScopePair[],
  limit: number,
  offset = 0,
  genres: string[] = [],
  includeGenreCounts = false,
): Promise<{ albums: ReturnType<typeof albumToAlbum>[]; hasMore: boolean; genreCounts: GenreAlbumCountRow[] }> {
  if (!anchorServerId) {
    emitMultiServerDebug('new_releases_local_skip', {
      reason: 'missing_anchor_server',
      inputScopes: scopes,
      limit,
      offset,
      genres,
      includeGenreCounts,
    });
    return { albums: [], hasMore: false, genreCounts: [] };
  }
  const effectiveScopes = scopes.length > 0
    ? scopes
    : [{ serverId: anchorServerId, libraryId: null }];
  const startedAt = performance.now();
  emitMultiServerDebug('new_releases_local_request_start', {
    anchorServerId,
    inputScopes: scopes,
    effectiveScopes,
    defensiveFallbackUsed: scopes.length === 0,
    limit,
    offset,
    genres,
    includeGenreCounts,
  });
  try {
    const response = await libraryScopeListMainstageAlbums(anchorServerId, {
      scopes: effectiveScopes,
      feed: 'newReleases',
      limit,
      offset,
      genres,
      includeGenreCounts,
    });
    const albums = response.albums.map(albumToAlbum);
    const ownerCounts = Object.fromEntries([...new Set(albums.map(album => album.serverId ?? ''))]
      .filter(Boolean)
      .map(serverId => [serverId, albums.filter(album => album.serverId === serverId).length]));
    emitMultiServerDebug('new_releases_local_request_done', {
      anchorServerId,
      effectiveScopes,
      defensiveFallbackUsed: scopes.length === 0,
      durationMs: Math.round(performance.now() - startedAt),
      albumCount: albums.length,
      ownerCounts,
      hasMore: response.hasMore,
      genreCount: response.genreCounts?.length ?? 0,
      sampleAlbums: response.albums.slice(0, 10).map(album => ({
        serverId: album.serverId,
        id: album.id,
        name: album.name,
        year: album.year ?? null,
        syncedAt: album.syncedAt,
        createdMs: album.rawJson && typeof album.rawJson === 'object'
          ? (album.rawJson as Record<string, unknown>).createdMs ?? null
          : null,
      })),
    });
    return {
      albums,
      hasMore: response.hasMore,
      genreCounts: response.genreCounts,
    };
  } catch (error) {
    emitMultiServerDebug('new_releases_local_request_error', {
      anchorServerId,
      effectiveScopes,
      defensiveFallbackUsed: scopes.length === 0,
      durationMs: Math.round(performance.now() - startedAt),
      error: describeMultiServerError(error),
    });
    throw error;
  }
}
