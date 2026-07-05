import { getStarredForServer } from '@/lib/api/subsonicStarRating';
import { libraryAdvancedSearch } from '@/lib/api/library';
import type {
  StarredResults,
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicSong,
} from '@/lib/api/subsonicTypes';
import { isActiveServerReachable } from '@/lib/network/activeServerReachability';
import {
  albumToAlbum,
  trackToSong,
} from '@/lib/library/advancedSearchLocal';
import { dedupeById } from '@/lib/util/dedupeById';
import { isOfflineBrowseActive } from '@/features/offline/utils/offlineBrowseMode';
import { favoritesServerIds } from '@/features/offline/utils/favoritesOfflineBrowse';
import {
  buildAlbumFromTracks,
  fetchBrowsableLocalTrackDtos,
  offlineLocalBrowseEnabled,
} from '@/features/offline/utils/offlineLocalBrowse';

function tagStarredWithServer(starred: StarredResults, serverId: string): StarredResults {
  const withServer = <T extends { id: string }>(items: T[]): (T & { serverId: string })[] =>
    items.map(item => ({ ...item, serverId }));

  return {
    artists: withServer(starred.artists),
    albums: withServer(starred.albums),
    songs: withServer(starred.songs),
  };
}

/** Merge starred lists from multiple servers; dedupe by `serverId:id`. */
export function mergeStarredFromServers(
  entries: { serverId: string; starred: StarredResults }[],
): StarredResults {
  const artists: SubsonicArtist[] = [];
  const albums: SubsonicAlbum[] = [];
  const songs: SubsonicSong[] = [];
  for (const { serverId, starred } of entries) {
    const tagged = tagStarredWithServer(starred, serverId);
    artists.push(...tagged.artists);
    albums.push(...tagged.albums);
    songs.push(...tagged.songs);
  }
  return {
    artists: dedupeById(artists),
    albums: dedupeById(albums),
    songs: dedupeById(songs),
  };
}

/**
 * Offline favorites: start from on-disk bytes, then keep starred tracks/albums only.
 * Avoids scanning the full starred catalog in SQL when only a local subset is playable.
 */
async function loadStarredFromBrowsableLocalBytes(serverId: string): Promise<StarredResults> {
  const allLocal = await fetchBrowsableLocalTrackDtos(serverId);
  if (allLocal.length === 0) {
    return { artists: [], albums: [], songs: [] };
  }

  const starredTracks = allLocal.filter(t => t.starredAt != null);
  const songs = starredTracks
    .map(trackToSong)
    .map(s => ({ ...s, serverId }));

  const albumsById = new Map<string, SubsonicAlbum>();
  const byStarredAlbum = new Map<string, typeof allLocal>();
  for (const track of starredTracks) {
    if (!track.albumId) continue;
    const list = byStarredAlbum.get(track.albumId) ?? [];
    list.push(track);
    byStarredAlbum.set(track.albumId, list);
  }
  for (const [albumId, albumTracks] of byStarredAlbum) {
    albumsById.set(albumId, buildAlbumFromTracks(albumId, albumTracks, serverId));
  }

  const localAlbumIds = [...new Set(
    allLocal.map(t => t.albumId).filter((id): id is string => !!id),
  )];
  if (localAlbumIds.length > 0) {
    const albumSearch = await libraryAdvancedSearch({
      serverId,
      entityTypes: ['album'],
      starredOnly: true,
      restrictAlbumIds: localAlbumIds,
      limit: localAlbumIds.length,
      skipTotals: true,
    });
    for (const dto of albumSearch.albums) {
      albumsById.set(dto.id, { ...albumToAlbum(dto), serverId });
    }
  }

  return {
    artists: [],
    albums: [...albumsById.values()],
    songs,
  };
}

export async function loadStarredFromLibraryIndex(
  serverId: string,
  preferLocalBytes = false,
): Promise<StarredResults> {
  if (preferLocalBytes && offlineLocalBrowseEnabled(serverId)) {
    return loadStarredFromBrowsableLocalBytes(serverId);
  }

  // Artist-level favorites are network-only today (`artist` has no `starred_at`;
  // `starredOnly` on artists would return the whole artist table). Songs/albums
  // use track/album stars in the index.
  const response = await libraryAdvancedSearch({
    serverId,
    entityTypes: ['album', 'track'],
    starredOnly: true,
    limit: 10_000,
  });
  return {
    artists: [],
    albums: response.albums.map(albumToAlbum),
    songs: response.tracks.map(trackToSong),
  };
}

export async function loadStarredFromAllLibraryIndexes(
  preferLocalBytes = isOfflineBrowseActive(),
): Promise<StarredResults> {
  const serverIds = favoritesServerIds();
  const entries = await Promise.all(
    serverIds.map(async serverId => {
      try {
        const starred = await loadStarredFromLibraryIndex(serverId, preferLocalBytes);
        return { serverId, starred };
      } catch {
        return { serverId, starred: { artists: [], albums: [], songs: [] } satisfies StarredResults };
      }
    }),
  );
  return mergeStarredFromServers(entries);
}

/** Online starred merge with per-server local index fallback. */
export async function loadStarredFromAllServersOnline(): Promise<StarredResults> {
  if (!isActiveServerReachable()) {
    return loadStarredFromAllLibraryIndexes();
  }
  const serverIds = favoritesServerIds();
  const entries = await Promise.all(
    serverIds.map(async serverId => {
      try {
        const starred = await getStarredForServer(serverId);
        return { serverId, starred };
      } catch {
        try {
          const starred = await loadStarredFromLibraryIndex(serverId);
          return { serverId, starred };
        } catch {
          return { serverId, starred: { artists: [], albums: [], songs: [] } satisfies StarredResults };
        }
      }
    }),
  );
  return mergeStarredFromServers(entries);
}
