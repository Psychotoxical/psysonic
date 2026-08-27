import { api, apiForServer, apiPostFormForServer, isHttp414, serverSupportsFormPost } from '@/lib/api/subsonicClient';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import {
  navidromeCanonicalBootstrapBlocksServer,
  navidromeCanonicalBootstrapIsActive,
} from '@/lib/server/navidromeCanonicalCheckpointStatus';
import {
  activeServerIdForExternalIngress,
  normalizeNavidromeExternalArtworkId,
  normalizeNavidromeExternalId,
} from '@/lib/server/navidromeCanonicalExternalId';
import { resolveStorageServerIndexKey } from '@/lib/server/serverIndexKey';

export type PlayQueueResult = { current?: string; position?: number; songs: SubsonicSong[] };

function parsePlayQueueResponse(
  data: { playQueue?: { current?: string; position?: number; entry?: SubsonicSong[] } },
  serverId?: string,
): PlayQueueResult {
  const pq = data.playQueue;
  if (!serverId) return { current: pq?.current, position: pq?.position, songs: pq?.entry ?? [] };
  const normalizeId = (id: string) => normalizeNavidromeExternalId(serverId, id);
  const songs = (pq?.entry ?? []).map(song => ({
    ...song,
    id: normalizeId(song.id),
    albumId: normalizeId(song.albumId),
    ...(song.artistId ? { artistId: normalizeId(song.artistId) } : {}),
    ...(song.coverArt
      ? { coverArt: normalizeNavidromeExternalArtworkId(serverId, song.coverArt) }
      : {}),
    ...(song.artists
      ? {
          artists: song.artists.map(artist => (
            artist.id ? { ...artist, id: normalizeId(artist.id) } : artist
          )),
        }
      : {}),
    ...(song.albumArtists
      ? {
          albumArtists: song.albumArtists.map(artist => (
            artist.id ? { ...artist, id: normalizeId(artist.id) } : artist
          )),
        }
      : {}),
    ...(song.contributors
      ? {
          contributors: song.contributors.map(contributor => ({
            ...contributor,
            artist: contributor.artist.id
              ? { ...contributor.artist, id: normalizeId(contributor.artist.id) }
              : contributor.artist,
          })),
        }
      : {}),
  }));
  return {
    current: pq?.current ? normalizeId(pq.current) : undefined,
    position: pq?.position,
    songs,
  };
}

export async function getPlayQueue(): Promise<PlayQueueResult> {
  try {
    const data = await api<{ playQueue: { current?: string; position?: number; entry?: SubsonicSong[] } }>('getPlayQueue.view');
    return parsePlayQueueResponse(data, activeServerIdForExternalIngress() ?? undefined);
  } catch {
    return { songs: [] };
  }
}

export async function getPlayQueueForServer(serverId: string): Promise<PlayQueueResult> {
  if (!serverId) return { songs: [] };
  try {
    return await fetchPlayQueueForServer(serverId);
  } catch {
    return { songs: [] };
  }
}

/** Error-preserving play-queue read for startup reconciliation. */
export async function fetchPlayQueueForServer(serverId: string): Promise<PlayQueueResult> {
  if (!serverId) throw new Error('Missing server id');
  const data = await apiForServer<{ playQueue: { current?: string; position?: number; entry?: SubsonicSong[] } }>(
    serverId,
    'getPlayQueue.view',
  );
  return parsePlayQueueResponse(data, serverId);
}

/**
 * Persist the play queue. Uses OpenSubsonic form POST when the server advertises
 * `formPost` (avoids HTTP 414 on large queues behind reverse proxies). Otherwise
 * GET, with a one-shot POST retry if the proxy returns 414.
 */
export async function savePlayQueue(
  songIds: string[],
  current: string | undefined,
  position: number | undefined,
  serverId: string,
): Promise<void> {
  if (!serverId) return;
  const serverIndexKey = resolveStorageServerIndexKey(serverId);
  if (
    navidromeCanonicalBootstrapIsActive() &&
    (!serverIndexKey || navidromeCanonicalBootstrapBlocksServer(serverIndexKey))
  ) {
    throw new Error('canonical_migration_active');
  }
  const params: Record<string, unknown> = {};
  if (songIds.length > 0) params.id = songIds;
  if (current !== undefined) params.current = current;
  if (position !== undefined) params.position = position;

  if (serverSupportsFormPost(serverId)) {
    await apiPostFormForServer(serverId, 'savePlayQueue.view', params);
    return;
  }

  try {
    await apiForServer(serverId, 'savePlayQueue.view', params);
  } catch (err) {
    if (isHttp414(err)) {
      await apiPostFormForServer(serverId, 'savePlayQueue.view', params);
      return;
    }
    throw err;
  }
}
