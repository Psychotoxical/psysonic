/**
 * Genre-detail bulk play/shuffle against the local library index.
 */
import {
  libraryAdvancedSearch,
  libraryGetGenreAlbumCounts,
  type LibraryScopePair,
  type LibrarySortClause,
} from '@/lib/api/library';
import { fetchAllSongsByGenre, getGenres } from '@/lib/api/subsonicGenres';
import type { SubsonicGenre } from '@/lib/api/subsonicTypes';
import {
  libraryScopeCacheKeyForServer,
  libraryScopeForServer,
  libraryScopePairsForServer,
  librarySelectionForServer,
} from '@/lib/api/subsonicClient';
import type { Track } from '@/lib/media/trackTypes';
import { songToTrack } from '@/lib/media/songToTrack';
import { shuffleArray } from '@/lib/util/shuffleArray';
import { trackToSong } from '@/lib/library/advancedSearchLocal';
import { type AlbumBrowseSort } from '@/lib/library/albumBrowseSort';
import {
  genreCatalogCacheKey,
  getInflightGenreCatalog,
  lookupGenreAlbumCount,
  peekGenreCatalogCache,
  trackInflightGenreCatalog,
  writeGenreCatalogCache,
} from '@/lib/library/genreCatalogCountsCache';
import { fetchGenreAlbumTotal } from '@/lib/library/genreAlbumBrowse';
import { libraryIsReady } from '@/lib/library/libraryReady';
import {
  fetchOfflineLocalGenreCatalog,
  isOfflineBrowseActive,
  offlineLocalBrowseEnabled,
} from '@/features/offline';

/** Drop genres with no indexed albums/tracks (stale server list or orphan rows). */
export function filterGenresWithContent(genres: SubsonicGenre[]): SubsonicGenre[] {
  return genres.filter(g => (g.albumCount ?? 0) > 0 || (g.songCount ?? 0) > 0);
}

async function loadLocalGenreCatalogRows(
  serverId: string,
  args: { libraryScope?: string; libraryScopes?: LibraryScopePair[] } = {},
): Promise<SubsonicGenre[]> {
  const rows = await libraryGetGenreAlbumCounts({
    serverId,
    ...args,
  });
  return filterGenresWithContent(rows.map(row => ({
    value: row.value,
    albumCount: row.albumCount,
    songCount: row.songCount,
  })));
}

async function fetchLocalGenreCatalog(
  serverId: string,
  scopeKey: string,
): Promise<SubsonicGenre[]> {
  const selection = librarySelectionForServer(serverId);
  const genres =
    selection.length === 0
      ? await loadLocalGenreCatalogRows(serverId, {
        libraryScopes: libraryScopePairsForServer(serverId),
      })
      : selection.length === 1
        ? await loadLocalGenreCatalogRows(serverId, { libraryScope: selection[0] })
        : await loadLocalGenreCatalogRows(serverId, {
          libraryScopes: selection.map(libraryId => ({ serverId, libraryId })),
        });
  writeGenreCatalogCache(serverId, scopeKey, genres);
  return genres;
}

/** Matches queueTrackResolver CACHE_CAP — whole seeded queue stays warm. */
export const GENRE_PLAYBACK_QUEUE_CAP = 500;

const PLAY_ORDER: LibrarySortClause[] = [
  { field: 'title', dir: 'asc' },
  { field: 'artist', dir: 'asc' },
];

const SHUFFLE_ORDER: LibrarySortClause[] = [{ field: 'random', dir: 'asc' }];

export async function fetchLocalGenreTracksForPlayback(
  serverId: string | null | undefined,
  genre: string,
  options: { shuffle?: boolean; cap?: number } = {},
): Promise<Track[] | null> {
  const cap = options.cap ?? GENRE_PLAYBACK_QUEUE_CAP;
  if (!serverId || !genre.trim() || !(await libraryIsReady(serverId))) return null;
  try {
    const resp = await libraryAdvancedSearch({
      serverId,
      libraryScope: libraryScopeForServer(serverId) ?? undefined,
      libraryScopes: libraryScopePairsForServer(serverId),
      entityTypes: ['track'],
      filters: [{ field: 'genre', op: 'eq', value: genre }],
      sort: options.shuffle ? SHUFFLE_ORDER : PLAY_ORDER,
      limit: cap,
      offset: 0,
      skipTotals: true,
    });
    if (resp.source !== 'local') return null;
    return resp.tracks.map(t => songToTrack(trackToSong(t)));
  } catch {
    return null;
  }
}

export async function fetchGenreTracksForPlayback(
  serverId: string | null | undefined,
  genre: string,
  options: { shuffle?: boolean; cap?: number; indexEnabled?: boolean } = {},
): Promise<Track[]> {
  const cap = options.cap ?? GENRE_PLAYBACK_QUEUE_CAP;
  const shuffle = !!options.shuffle;
  if (options.indexEnabled !== false) {
    const local = await fetchLocalGenreTracksForPlayback(serverId, genre, { shuffle, cap });
    if (local) return local;
  }
  const songs = await fetchAllSongsByGenre(genre, cap);
  const tracks = songs.map(songToTrack);
  return shuffle ? shuffleArray(tracks) : tracks;
}

export async function fetchGenreAlbumCount(
  serverId: string | null | undefined,
  genre: string,
  indexEnabled: boolean,
  sort: AlbumBrowseSort = 'alphabeticalByName',
): Promise<number | null> {
  if (!genre.trim()) return null;
  if (indexEnabled && serverId) {
    if (isOfflineBrowseActive() && offlineLocalBrowseEnabled(serverId)) {
      const genres = await fetchOfflineLocalGenreCatalog(serverId);
      const match = genres.find(
        g => g.value.localeCompare(genre, undefined, { sensitivity: 'accent' }) === 0,
      );
      return match?.albumCount ?? null;
    }
    const scopeKey = libraryScopeCacheKeyForServer(serverId);
    const cached = lookupGenreAlbumCount(serverId, genre, scopeKey);
    if (cached != null) return cached;
    const inflight = getInflightGenreCatalog(genreCatalogCacheKey(serverId, scopeKey));
    if (inflight) {
      const catalog = await inflight;
      const match = catalog.find(g => g.value.localeCompare(genre, undefined, { sensitivity: 'accent' }) === 0);
      if (match?.albumCount != null) return match.albumCount;
    }
    const localTotal = await fetchGenreAlbumTotal(serverId, genre, indexEnabled, sort);
    if (localTotal != null) return localTotal;
    return null;
  }
  try {
    const genres = await getGenres();
    const match = genres.find(g => g.value.localeCompare(genre, undefined, { sensitivity: 'accent' }) === 0);
    return match?.albumCount ?? null;
  } catch {
    return null;
  }
}

/** Genres cloud + detail header: local index counts when ready, else Navidrome `getGenres`. */
export async function fetchGenreCatalog(
  serverId: string | null | undefined,
  indexEnabled: boolean,
  scopePairs?: LibraryScopePair[],
  localOnly = false,
  scopeKeyOverride?: string,
): Promise<SubsonicGenre[]> {
  if (!serverId) return getGenres();

  const scopeKey = scopeKeyOverride ?? libraryScopeCacheKeyForServer(serverId);
  const cacheKey = genreCatalogCacheKey(serverId, scopeKey);
  const offlineLocal = isOfflineBrowseActive() && offlineLocalBrowseEnabled(serverId);

  if (offlineLocal) {
    return filterGenresWithContent(await fetchOfflineLocalGenreCatalog(serverId));
  }

  const fresh = peekGenreCatalogCache(serverId, scopeKey, false);
  if (fresh) return fresh;

  const stale = peekGenreCatalogCache(serverId, scopeKey, true);
  const inflight = getInflightGenreCatalog(cacheKey);
  if (inflight) {
    if (stale) return stale;
    return inflight;
  }

  const load = async (): Promise<SubsonicGenre[]> => {
    if (indexEnabled && (await libraryIsReady(serverId))) {
      try {
        if (scopePairs !== undefined) {
          const genres = await loadLocalGenreCatalogRows(serverId, { libraryScopes: scopePairs });
          writeGenreCatalogCache(serverId, scopeKey, genres);
          return genres;
        }
        return await fetchLocalGenreCatalog(serverId, scopeKey);
      } catch {
        if (localOnly) return [];
      }
    }
    if (localOnly) return [];
    const genres = filterGenresWithContent(await getGenres());
    writeGenreCatalogCache(serverId, scopeKey, genres);
    return genres;
  };

  const promise = load();
  trackInflightGenreCatalog(cacheKey, promise);

  if (stale) {
    void promise.catch(() => {});
    return stale;
  }
  return promise;
}
