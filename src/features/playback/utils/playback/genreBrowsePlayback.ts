/**
 * Genre-detail bulk play/shuffle against the local library index.
 */
import { libraryAdvancedSearch, libraryGetGenreAlbumCounts, type LibrarySortClause } from '@/lib/api/library';
import { fetchAllSongsByGenre, getGenres } from '@/lib/api/subsonicGenres';
import type { SubsonicGenre } from '@/lib/api/subsonicTypes';
import { libraryScopeForServer } from '@/lib/api/subsonicClient';
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

/** Drop genres with no indexed albums/tracks (stale server list or orphan rows). */
export function filterGenresWithContent(genres: SubsonicGenre[]): SubsonicGenre[] {
  return genres.filter(g => (g.albumCount ?? 0) > 0 || (g.songCount ?? 0) > 0);
}

async function loadLocalGenreCatalogRows(
  serverId: string,
  libraryScope: string | undefined,
): Promise<SubsonicGenre[]> {
  const rows = await libraryGetGenreAlbumCounts({
    serverId,
    libraryScope,
  });
  return filterGenresWithContent(rows.map(row => ({
    value: row.value,
    albumCount: row.albumCount,
    songCount: row.songCount,
  })));
}

async function fetchLocalGenreCatalog(
  serverId: string,
  libraryScope: string | undefined,
): Promise<SubsonicGenre[]> {
  const genres = await loadLocalGenreCatalogRows(serverId, libraryScope);
  writeGenreCatalogCache(serverId, libraryScope, genres);
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
    const scope = libraryScopeForServer(serverId);
    const cached = lookupGenreAlbumCount(serverId, genre, scope);
    if (cached != null) return cached;
    const inflight = getInflightGenreCatalog(genreCatalogCacheKey(serverId, scope));
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
): Promise<SubsonicGenre[]> {
  if (!serverId) return getGenres();

  const scope = libraryScopeForServer(serverId);
  const cacheKey = genreCatalogCacheKey(serverId, scope);
  const fresh = peekGenreCatalogCache(serverId, scope, false);
  if (fresh) return fresh;

  const stale = peekGenreCatalogCache(serverId, scope, true);
  const inflight = getInflightGenreCatalog(cacheKey);
  if (inflight) {
    if (stale) return stale;
    return inflight;
  }

  const load = async (): Promise<SubsonicGenre[]> => {
    if (indexEnabled && (await libraryIsReady(serverId))) {
      try {
        return await fetchLocalGenreCatalog(serverId, scope);
      } catch {
        /* network fallback */
      }
    }
    const genres = filterGenresWithContent(await getGenres());
    writeGenreCatalogCache(serverId, scope, genres);
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
