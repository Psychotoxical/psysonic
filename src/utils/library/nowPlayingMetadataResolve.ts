/**
 * Index-first metadata resolvers for the Now Playing page (issue #1046).
 *
 * The local library index is first-class: when SQLite has the row, Now Playing
 * reads it there; Subsonic/network is fallback only on index miss / index off /
 * not ready. This mirrors the in-tree index-first family (`queueTrackResolver`,
 * `offlineLibraryIndexLoad`, `useQueueTrackEnrichment`) rather than adding a
 * fourth always-network path.
 *
 * Each resolver returns the exact shape the corresponding Now Playing TTL cache
 * already stores, so `useNowPlayingFetchers` / `prewarmNowPlayingFetchers` swap
 * the single fetch expression in place — caches, id-gating, and the network
 * guard stay unchanged.
 *
 * `artistInfo` (bio / similar) has no index source and stays network-only — it
 * is intentionally absent here.
 */
import { libraryAdvancedSearch, libraryGetTrack } from '../../api/library';
import { getArtistForServer, getTopSongsForServer } from '../../api/subsonicArtists';
import { getAlbumForServer, getSongForServer } from '../../api/subsonicLibrary';
import type { SubsonicAlbum, SubsonicSong } from '../../api/subsonicTypes';
import { loadAlbumFromLibraryIndex, loadArtistFromLibraryIndex } from '../offline/offlineLibraryIndexLoad';
import { trackToSong } from './advancedSearchLocal';
import { libraryIsReady } from './libraryReady';

const TOP_SONGS_LIMIT = 5;

/** Album card — index `loadAlbumFromLibraryIndex`, else `getAlbumForServer`. */
export async function resolveNpAlbum(
  serverId: string,
  albumId: string,
): Promise<{ album: SubsonicAlbum; songs: SubsonicSong[] } | null> {
  if (await libraryIsReady(serverId)) {
    try {
      const hit = await loadAlbumFromLibraryIndex(serverId, albumId);
      if (hit) return hit;
    } catch { /* index error → network fallback */ }
  }
  return getAlbumForServer(serverId, albumId);
}

/** Discography — index `loadArtistFromLibraryIndex().albums`, else `getArtistForServer().albums`. */
export async function resolveNpDiscography(
  serverId: string,
  artistId: string,
): Promise<SubsonicAlbum[]> {
  if (await libraryIsReady(serverId)) {
    try {
      const hit = await loadArtistFromLibraryIndex(serverId, artistId);
      // Empty albums == miss: the index may not carry this artist's albums yet;
      // let the network arm try before settling on an empty discography.
      if (hit && hit.albums.length > 0) return hit.albums;
    } catch { /* index error → network fallback */ }
  }
  const artist = await getArtistForServer(serverId, artistId);
  return artist.albums;
}

/**
 * Most played — there is no ready index loader (`loadArtistFromLibraryIndex`
 * leaves top songs empty). Query the index for this artist's tracks by
 * `play_count` desc; the filter registry has no artist field, so an FTS query
 * on the name plus a client-side `artistId` match is the in-tree precedent
 * (see `useArtistDetailData`).
 */
export async function resolveNpTopSongs(
  serverId: string,
  artistId: string | undefined,
  artistName: string,
): Promise<SubsonicSong[]> {
  if (artistId && artistName && await libraryIsReady(serverId)) {
    try {
      const resp = await libraryAdvancedSearch({
        serverId,
        entityTypes: ['track'],
        query: artistName,
        sort: [{ field: 'play_count', dir: 'desc' }],
        limit: 50,
        skipTotals: true,
      });
      if (resp.source === 'local') {
        const songs = resp.tracks
          .map(trackToSong)
          .filter(s => s.artistId === artistId)
          .slice(0, TOP_SONGS_LIMIT);
        if (songs.length > 0) return songs;
      }
    } catch { /* index error → network fallback */ }
  }
  return getTopSongsForServer(serverId, artistName);
}

/** Song-level meta — index `libraryGetTrack` → `trackToSong`, else `getSongForServer`. */
export async function resolveNpSongMeta(
  serverId: string,
  songId: string,
): Promise<SubsonicSong | null> {
  if (await libraryIsReady(serverId)) {
    try {
      const dto = await libraryGetTrack(serverId, songId);
      if (dto) return trackToSong(dto);
    } catch { /* index error → network fallback */ }
  }
  // Network arm keeps its own byte-style guard (`shouldAttemptSubsonicForServer`
  // with the trackId + psysonic-local:// skip) — unchanged from #1042.
  return getSongForServer(serverId, songId);
}
