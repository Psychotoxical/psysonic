import { getStarredForServer } from '../../api/subsonicStarRating';
import { isActiveServerReachable } from '../network/activeServerReachability';
import { shouldAttemptSubsonicForServer } from '../network/subsonicNetworkGuard';
import { getAlbumForServer } from '../../api/subsonicLibrary';
import { libraryAdvancedSearch, libraryGetTracksByAlbum } from '../../api/library';
import type {
  StarredResults,
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicSong,
} from '../../api/subsonicTypes';
import { useAuthStore } from '../../store/authStore';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';
import type { OfflineAlbumMeta } from '../../store/offlineStore';
import {
  albumToAlbum,
  artistToArtist,
  trackToSong,
} from '../library/advancedSearchLocal';
import { dedupeById } from '../dedupeById';
import { countFavoriteAutoTracks, hasAnyOfflineAlbums } from './offlineLibraryHelpers';

/** Saved servers with a local library index (cross-server favorites scope). */
export function favoritesServerIds(): string[] {
  const { servers } = useAuthStore.getState();
  const idx = useLibraryIndexStore.getState();
  return idx.indexedServerIds(servers.map(s => s.id));
}

/** Favorites page may be browsed offline when auto-save is enabled and any index exists. */
export function favoritesOfflineBrowseEnabled(): boolean {
  const auth = useAuthStore.getState();
  if (!auth.favoritesOfflineEnabled) return false;
  return favoritesServerIds().length > 0;
}

export function isOfflineSidebarLibraryNavAllowed(
  navId: string,
  favoritesOfflineBrowse: boolean,
): boolean {
  if (navId === 'favorites') return favoritesOfflineBrowse;
  return false;
}

/** Any offline browsing surface: manual pins and/or saved favorite-auto bytes. */
export function hasOfflineBrowsingContent(
  offlineAlbums: Record<string, OfflineAlbumMeta>,
): boolean {
  if (hasAnyOfflineAlbums(offlineAlbums)) return true;
  if (favoritesOfflineBrowseEnabled() && countFavoriteAutoTracks() > 0) return true;
  return false;
}

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

export async function loadStarredFromLibraryIndex(serverId: string): Promise<StarredResults> {
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

export async function loadStarredFromAllLibraryIndexes(): Promise<StarredResults> {
  const serverIds = favoritesServerIds();
  const entries = await Promise.all(
    serverIds.map(async serverId => {
      try {
        const starred = await loadStarredFromLibraryIndex(serverId);
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

/**
 * Album detail / play / offline pin: use the network album when reachable so the
 * track list is complete. The library index may only contain a subset (e.g.
 * starred tracks or a partial sync) — never prefer that over `getAlbum` online.
 * When the server is unreachable, fall back to the index when favorites-offline
 * browsing is enabled.
 */
export async function resolveAlbumForServer(
  serverId: string,
  albumId: string,
): Promise<{ album: SubsonicAlbum; songs: SubsonicSong[] } | null> {
  const favoritesOffline = useAuthStore.getState().favoritesOfflineEnabled;
  const networkAllowed = shouldAttemptSubsonicForServer(serverId);

  if (networkAllowed) {
    try {
      const data = await getAlbumForServer(serverId, albumId);
      return { album: data.album, songs: data.songs };
    } catch {
      /* fall through to library index */
    }
  } else if (!favoritesOffline) {
    return null;
  }

  try {
    return await loadAlbumFromLibraryIndex(serverId, albumId);
  } catch {
    return null;
  }
}

export async function loadAlbumFromLibraryIndex(
  serverId: string,
  albumId: string,
): Promise<{ album: SubsonicAlbum; songs: SubsonicSong[] } | null> {
  const tracks = await libraryGetTracksByAlbum(serverId, albumId);
  if (tracks.length === 0) return null;

  const songs = tracks.map(trackToSong);
  const albumSearch = await libraryAdvancedSearch({
    serverId,
    entityTypes: ['album'],
    restrictAlbumIds: [albumId],
    limit: 1,
  });
  const albumDto = albumSearch.albums[0];
  if (albumDto) {
    const album = albumToAlbum(albumDto);
    return {
      album: {
        ...album,
        serverId,
        songCount: songs.length,
        duration: songs.reduce((sum, s) => sum + (s.duration ?? 0), 0),
      },
      songs: songs.map(s => ({ ...s, serverId })),
    };
  }

  const first = tracks[0];
  return {
    album: {
      id: albumId,
      name: first.album ?? albumId,
      artist: first.artist ?? '',
      artistId: first.artistId ?? '',
      songCount: songs.length,
      duration: songs.reduce((sum, s) => sum + (s.duration ?? 0), 0),
      coverArt: first.coverArtId ?? albumId,
      year: first.year ?? undefined,
      genre: first.genre ?? undefined,
      starred: first.starredAt != null ? new Date(first.starredAt).toISOString() : undefined,
      serverId,
    },
    songs: songs.map(s => ({ ...s, serverId })),
  };
}

export async function loadArtistFromLibraryIndex(
  serverId: string,
  artistId: string,
): Promise<{ artist: SubsonicArtist; albums: SubsonicAlbum[] } | null> {
  const response = await libraryAdvancedSearch({
    serverId,
    entityTypes: ['album', 'artist'],
    limit: 10_000,
  });
  const albums = response.albums
    .filter(a => a.artistId === artistId)
    .map(albumToAlbum)
    .map(a => ({ ...a, serverId }));
  const artistDto = response.artists.find(a => a.id === artistId);
  if (!artistDto && albums.length === 0) return null;

  const artist = artistDto
    ? { ...artistToArtist(artistDto), serverId }
    : {
      id: artistId,
      name: albums[0]?.artist ?? artistId,
      albumCount: albums.length,
      serverId,
    };

  return {
    artist: {
      ...artist,
      albumCount: albums.length,
    },
    albums,
  };
}
