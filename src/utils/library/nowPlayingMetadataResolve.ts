/**
 * Index-first metadata resolvers for the Now Playing page (issue #1046).
 *
 * The local library index is first-class: when SQLite has the row, Now Playing
 * reads it there; Subsonic/network is fallback only on index miss / index off /
 * not ready. This mirrors the in-tree index-first family (`queueTrackResolver`,
 * `offlineLibraryIndexLoad`, `useQueueTrackEnrichment`) rather than adding a
 * fourth always-network path.
 *
 * Gate split (PR #1049 review): the index arm runs whenever there is a playback
 * server id — including when the server is unreachable, the whole point of
 * index-first for offline-pinned playback. The reachability guard
 * (`shouldAttemptSubsonicForServer`, no trackId) lives only in each resolver's
 * **network fallback arm**, so offline reads still succeed from SQLite.
 *
 * `artistInfo` (bio / similar) has no index source and stays network-only — it
 * is intentionally absent here.
 */
import { libraryGetTrack, libraryGetTracksByAlbum } from '../../api/library';
import { getArtistForServer, getTopSongsForServer } from '../../api/subsonicArtists';
import { getAlbumForServer, getSongForServer } from '../../api/subsonicLibrary';
import type { SubsonicAlbum, SubsonicSong } from '../../api/subsonicTypes';
import { shouldAttemptSubsonicForServer } from '../network/subsonicNetworkGuard';
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
  if (!shouldAttemptSubsonicForServer(serverId)) return null;
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
  if (!shouldAttemptSubsonicForServer(serverId)) return [];
  const artist = await getArtistForServer(serverId, artistId);
  return artist.albums;
}

/**
 * Most played — derive from the artist's own discography albums (same bucket the
 * discography card uses), sorted by play_count. This is deterministic: it can't
 * pull the wrong artist's tracks the way an FTS-on-name query could. Network
 * `getTopSongsForServer` is the fallback on index miss / off / unreachable.
 */
export async function resolveNpTopSongs(
  serverId: string,
  artistId: string | undefined,
  artistName: string,
): Promise<SubsonicSong[]> {
  if (artistId && await libraryIsReady(serverId)) {
    try {
      const hit = await loadArtistFromLibraryIndex(serverId, artistId);
      if (hit && hit.albums.length > 0) {
        const perAlbum = await Promise.all(
          hit.albums.map(a => libraryGetTracksByAlbum(serverId, a.id).catch(() => [])),
        );
        const songs = perAlbum
          .flat()
          .map(trackToSong)
          .sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0))
          .slice(0, TOP_SONGS_LIMIT);
        if (songs.length > 0) return songs;
      }
    } catch { /* index error → network fallback */ }
  }
  if (!shouldAttemptSubsonicForServer(serverId)) return [];
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
