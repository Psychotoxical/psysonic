/**
 * Genre-detail bulk play/shuffle against the local library index.
 */
import { libraryAdvancedSearch, libraryGetGenreAlbumCounts, type LibrarySortClause } from '../../api/library';
import { fetchAllSongsByGenre, getGenres } from '../../api/subsonicGenres';
import type { SubsonicGenre } from '../../api/subsonicTypes';
import { libraryScopeForServer } from '../../api/subsonicClient';
import type { Track } from '../../store/playerStoreTypes';
import { songToTrack } from '../playback/songToTrack';
import { shuffleArray } from '../playback/shuffleArray';
import { trackToSong } from './advancedSearchLocal';
import { libraryIsReady } from './libraryReady';

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
): Promise<number | null> {
  if (!genre.trim()) return null;
  if (indexEnabled && serverId && (await libraryIsReady(serverId))) {
    try {
      const resp = await libraryAdvancedSearch({
        serverId,
        libraryScope: libraryScopeForServer(serverId) ?? undefined,
        entityTypes: ['album'],
        filters: [{ field: 'genre', op: 'eq', value: genre }],
        limit: 1,
        offset: 0,
        skipTotals: false,
      });
      if (resp.source === 'local') return resp.totals.albums;
    } catch {
      /* network fallback */
    }
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
  if (indexEnabled && serverId && (await libraryIsReady(serverId))) {
    try {
      const rows = await libraryGetGenreAlbumCounts({
        serverId,
        libraryScope: libraryScopeForServer(serverId) ?? undefined,
      });
      return rows.map(row => ({
        value: row.value,
        albumCount: row.albumCount,
        songCount: row.songCount,
      }));
    } catch {
      /* network fallback */
    }
  }
  return getGenres();
}
