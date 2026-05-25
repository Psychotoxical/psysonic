import type { CoverServerScope } from '../../cover/types';
import { useAuthStore } from '../../store/authStore';
import type { OfflineAlbumMeta, OfflineTrackMeta } from '../../store/offlineStore';
import { switchActiveServer } from '../server/switchActiveServer';
import type { Track } from '../../store/playerStoreTypes';
import { findServerByIdOrIndexKey, resolveServerIdForIndexKey } from '../server/serverLookup';

export function hasAnyOfflineAlbums(albums: Record<string, OfflineAlbumMeta>): boolean {
  return Object.keys(albums).length > 0;
}

export function buildOfflineTracksForAlbum(
  album: OfflineAlbumMeta,
  tracks: Record<string, OfflineTrackMeta>,
): Track[] {
  const { serverId } = album;
  return album.trackIds.flatMap(tid => {
    const t = tracks[`${serverId}:${tid}`];
    if (!t) return [];
    return [{
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      albumId: t.albumId,
      artistId: t.artistId,
      duration: t.duration,
      coverArt: t.coverArt,
      track: undefined,
      year: t.year,
      bitRate: t.bitRate,
      suffix: t.suffix,
      genre: t.genre,
      replayGainTrackDb: t.replayGainTrackDb,
      replayGainAlbumDb: t.replayGainAlbumDb,
      replayGainPeak: t.replayGainPeak,
    }];
  });
}

/** Server scope for offline album covers — same host index key as main library disk cache. */
export function offlineAlbumCoverScope(album: OfflineAlbumMeta): CoverServerScope | null {
  if (!album.coverArt) return null;
  const server = findServerByIdOrIndexKey(album.serverId);
  if (!server) return null;
  return {
    kind: 'server',
    serverId: server.id,
    url: server.url,
    username: server.username,
    password: server.password,
  };
}

/** Switch active server when it differs from the album's source server (for offline play). */
export async function ensureServerForOfflineAlbum(album: OfflineAlbumMeta): Promise<boolean> {
  const { activeServerId, servers } = useAuthStore.getState();
  const resolved = resolveServerIdForIndexKey(album.serverId);
  if (resolved === activeServerId) return true;
  const server = servers.find(s => s.id === resolved)
    ?? findServerByIdOrIndexKey(album.serverId);
  if (!server) return false;
  return switchActiveServer(server);
}

export function offlineTrackCount(
  album: OfflineAlbumMeta,
  tracks: Record<string, OfflineTrackMeta>,
): number {
  return album.trackIds.filter(tid => !!tracks[`${album.serverId}:${tid}`]).length;
}
