import { useAuthStore } from '@/store/authStore';
import {
  shouldAttemptSubsonicForActiveServer,
  shouldAttemptSubsonicForServer,
} from '@/lib/network/subsonicNetworkGuard';
import { api, apiForServer, libraryFilterParams, libraryFilterParamsForServer, librarySelectionForServer } from '@/lib/api/subsonicClient';
import { getLuckyMixLibraryScopeOverride } from '@/lib/library/luckyMixScopeOverride';
import { mirrorAlbumMetadataFromServerOnUse } from '@/lib/library/patchOnUse';
import { resolveIndexKey } from '@/lib/server/serverIndexKey';
import type {
  RandomSongsFilters,
  SubsonicAlbum,
  SubsonicDirectory,
  SubsonicDirectoryEntry,
  SubsonicMusicFolder,
  SubsonicSong,
} from '@/lib/api/subsonicTypes';

function mapMusicIndexes(data: { indexes: { index?: { name: string; artist?: { id: string; name: string; coverArt?: string } | { id: string; name: string; coverArt?: string }[] } | { name: string; artist?: { id: string; name: string; coverArt?: string } | { id: string; name: string; coverArt?: string }[] }[] } }): SubsonicDirectoryEntry[] {
  const raw = data.indexes?.index;
  if (!raw) return [];
  const indices = Array.isArray(raw) ? raw : [raw];
  const entries: SubsonicDirectoryEntry[] = [];
  for (const idx of indices) {
    const artists = idx.artist ? (Array.isArray(idx.artist) ? idx.artist : [idx.artist]) : [];
    for (const artist of artists) {
      entries.push({ id: artist.id, title: artist.name, isDir: true, coverArt: artist.coverArt });
    }
  }
  return entries;
}

export async function getMusicDirectory(id: string): Promise<SubsonicDirectory> {
  const data = await api<{ directory: { id: string; parent?: string; name: string; child?: SubsonicDirectoryEntry | SubsonicDirectoryEntry[] } }>(
    'getMusicDirectory.view',
    { id },
  );
  const dir = data.directory;
  const raw = dir.child;
  const child: SubsonicDirectoryEntry[] = !raw ? [] : Array.isArray(raw) ? raw : [raw];
  return { id: dir.id, parent: dir.parent, name: dir.name, child };
}

/** Returns the top-level artist/directory entries for a music folder root.
 *  Music folder IDs from getMusicFolders() are NOT valid getMusicDirectory IDs —
 *  use getIndexes.view with musicFolderId instead. */
export async function getMusicIndexes(musicFolderId: string): Promise<SubsonicDirectoryEntry[]> {
  const data = await api<{ indexes: { index?: { name: string; artist?: { id: string; name: string; coverArt?: string } | { id: string; name: string; coverArt?: string }[] } | { name: string; artist?: { id: string; name: string; coverArt?: string } | { id: string; name: string; coverArt?: string }[] }[] } }>(
    'getIndexes.view',
    { musicFolderId },
  );
  return mapMusicIndexes(data);
}

function mapMusicFolders(data: { musicFolders: { musicFolder: SubsonicMusicFolder | SubsonicMusicFolder[] } }): SubsonicMusicFolder[] {
  const raw = data.musicFolders?.musicFolder;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map(f => ({
    id: String((f as { id: string | number }).id),
    name: (f as { name?: string }).name ?? 'Library',
  }));
}

export async function getMusicFolders(): Promise<SubsonicMusicFolder[]> {
  const data = await api<{ musicFolders: { musicFolder: SubsonicMusicFolder | SubsonicMusicFolder[] } }>(
    'getMusicFolders.view',
  );
  return mapMusicFolders(data);
}

export async function getMusicFoldersForServer(serverId: string): Promise<SubsonicMusicFolder[]> {
  const data = await apiForServer<{ musicFolders: { musicFolder: SubsonicMusicFolder | SubsonicMusicFolder[] } }>(
    serverId,
    'getMusicFolders.view',
  );
  return mapMusicFolders(data);
}

export async function getRandomAlbums(size = 6): Promise<SubsonicAlbum[]> {
  if (!shouldAttemptSubsonicForActiveServer()) return [];
  const data = await api<{ albumList2: { album: SubsonicAlbum[] } }>('getAlbumList2.view', {
    type: 'random',
    size,
    ...libraryFilterParams(),
  });
  return data.albumList2?.album ?? [];
}

export async function getAlbumList(
  type: 'random' | 'newest' | 'alphabeticalByName' | 'alphabeticalByArtist' | 'byYear' | 'recent' | 'starred' | 'frequent' | 'highest',
  size = 30,
  offset = 0,
  extra: Record<string, unknown> = {}
): Promise<SubsonicAlbum[]> {
  if (!shouldAttemptSubsonicForActiveServer()) return [];
  const data = await api<{ albumList2: { album: SubsonicAlbum[] } }>('getAlbumList2.view', {
    type,
    size,
    offset,
    _t: Date.now(),
    ...libraryFilterParams(),
    ...extra,
  });
  return data.albumList2?.album ?? [];
}

/**
 * Navidrome (and some servers) ignore `musicFolderId` on getSimilarSongs / getSimilarSongs2 / getTopSongs,
 * so similar tracks can leak from other libraries. When the user scoped to one folder, we keep a set of
 * album ids in that scope (paginated getAlbumList2) and drop songs whose albumId is not in the set.
 */
let scopedLibraryAlbumIdCache: {
  serverId: string;
  folderId: string;
  filterVersion: number;
  ids: Set<string>;
} | null = null;

async function albumIdsInLibraryScope(serverId: string): Promise<Set<string> | null> {
  const { musicLibraryFilterByServer, musicLibraryFilterVersion } = useAuthStore.getState();
  if (!serverId) return null;

  const override = getLuckyMixLibraryScopeOverride();
  let folder: string | null = null;
  if (override) {
    folder = override;
  } else {
    const selection = librarySelectionForServer(serverId);
    if (selection.length === 1) {
      folder = selection[0];
    } else {
      const legacy = musicLibraryFilterByServer[serverId];
      if (legacy !== undefined && legacy !== 'all') folder = legacy;
    }
  }
  if (!folder) {
    scopedLibraryAlbumIdCache = null;
    return null;
  }
  const hit = scopedLibraryAlbumIdCache;
  if (
    hit &&
    hit.serverId === serverId &&
    hit.folderId === folder &&
    hit.filterVersion === musicLibraryFilterVersion
  ) {
    return hit.ids;
  }
  const ids = new Set<string>();
  const pageSize = 500;
  let offset = 0;
  for (;;) {
    const albums = await getAlbumListForServer(serverId, 'alphabeticalByName', pageSize, offset);
    for (const a of albums) ids.add(a.id);
    if (albums.length < pageSize) break;
    offset += pageSize;
    if (offset > 500_000) break;
  }
  scopedLibraryAlbumIdCache = {
    serverId,
    folderId: folder,
    filterVersion: musicLibraryFilterVersion,
    ids,
  };
  return ids;
}

export async function filterSongsToServerLibrary(
  songs: SubsonicSong[],
  serverId: string,
): Promise<SubsonicSong[]> {
  const allowed = await albumIdsInLibraryScope(serverId);
  if (!allowed || allowed.size === 0) return songs;
  return songs.filter(s => s.albumId && allowed.has(s.albumId));
}

export async function filterSongsToActiveLibrary(songs: SubsonicSong[]): Promise<SubsonicSong[]> {
  const { activeServerId } = useAuthStore.getState();
  if (!activeServerId) return songs;
  return filterSongsToServerLibrary(songs, activeServerId);
}

/** Client-side album scope filter — same album-id set as {@link filterSongsToServerLibrary}. */
export function filterAlbumsByScopedAlbumIds(
  albums: SubsonicAlbum[],
  allowed: Set<string> | null,
): SubsonicAlbum[] {
  if (!allowed || allowed.size === 0) return albums;
  return albums.filter(a => allowed.has(a.id));
}

export async function filterAlbumsToServerLibrary(
  albums: SubsonicAlbum[],
  serverId: string,
): Promise<SubsonicAlbum[]> {
  const allowed = await albumIdsInLibraryScope(serverId);
  return filterAlbumsByScopedAlbumIds(albums, allowed);
}

export async function filterAlbumsToActiveLibrary(albums: SubsonicAlbum[]): Promise<SubsonicAlbum[]> {
  const { activeServerId } = useAuthStore.getState();
  if (!activeServerId) return albums;
  return filterAlbumsToServerLibrary(albums, activeServerId);
}

/** When scoped to one library, ask the server for more similar tracks — many will be filtered out client-side. */
export function similarSongsRequestCount(desired: number, serverId?: string): number {
  if (getLuckyMixLibraryScopeOverride()) {
    return Math.min(300, Math.max(desired, desired * 4));
  }
  const { activeServerId, musicLibraryFilterByServer } = useAuthStore.getState();
  const ownerServerId = serverId ?? activeServerId;
  const f = ownerServerId ? musicLibraryFilterByServer[ownerServerId] : undefined;
  if (f === undefined || f === 'all') return desired;
  return Math.min(300, Math.max(desired, desired * 4));
}

export async function getRandomSongs(size = 50, genre?: string, timeout = 15000): Promise<SubsonicSong[]> {
  const params: Record<string, string | number> = { size, _t: Date.now(), ...libraryFilterParams() };
  if (genre) params.genre = genre;
  const data = await api<{ randomSongs: { song: SubsonicSong[] } }>('getRandomSongs.view', params, timeout);
  return data.randomSongs?.song ?? [];
}

export async function getRandomSongsForServer(
  serverId: string,
  size = 50,
  genre?: string,
  timeout = 15000,
  explicitLibraryIds?: readonly string[],
): Promise<SubsonicSong[]> {
  if (!shouldAttemptSubsonicForServer(serverId)) return [];
  const fetchForLibrary = async (libraryId?: string): Promise<SubsonicSong[]> => {
    const params: Record<string, string | number> = {
      size,
      _t: Date.now(),
      ...(libraryId
        ? { musicFolderId: libraryId }
        : explicitLibraryIds
          ? {}
          : libraryFilterParamsForServer(serverId)),
    };
    if (genre) params.genre = genre;
    const data = await apiForServer<{ randomSongs: { song: SubsonicSong[] } }>(
      serverId,
      'getRandomSongs.view',
      params,
      timeout,
    );
    return data.randomSongs?.song ?? [];
  };
  const rawSongs = explicitLibraryIds && explicitLibraryIds.length > 1
    ? (await Promise.all(explicitLibraryIds.map(libraryId => (
        fetchForLibrary(libraryId).catch(() => [])
      )))).flat()
    : await fetchForLibrary(explicitLibraryIds?.[0]);
  const scopedSongs = explicitLibraryIds
    ? rawSongs
    : await filterSongsToServerLibrary(rawSongs, serverId);
  const songs = [...new Map(scopedSongs.map(song => [song.id, song])).values()].slice(0, size);
  const ownerServerKey = resolveIndexKey(serverId);
  return songs.map(song => ({ ...song, serverId: ownerServerKey }));
}

/** Extended random song fetch with server-side year/genre filtering. */
export async function getRandomSongsFiltered(
  filters: RandomSongsFilters,
  timeout = 15000,
): Promise<SubsonicSong[]> {
  const params: Record<string, string | number> = {
    size: filters.size ?? 50,
    _t: Date.now(),
    ...libraryFilterParams(),
  };
  if (filters.genre) params.genre = filters.genre;
  if (typeof filters.fromYear === 'number') params.fromYear = filters.fromYear;
  if (typeof filters.toYear === 'number') params.toYear = filters.toYear;
  const data = await api<{ randomSongs: { song: SubsonicSong[] } }>('getRandomSongs.view', params, timeout);
  return data.randomSongs?.song ?? [];
}

export async function getAlbumListForServer(
  serverId: string,
  type: 'random' | 'newest' | 'alphabeticalByName' | 'alphabeticalByArtist' | 'byYear' | 'recent' | 'starred' | 'frequent' | 'highest',
  size = 30,
  offset = 0,
  extra: Record<string, unknown> = {},
  timeout = 15000,
  explicitLibraryIds?: readonly string[],
): Promise<SubsonicAlbum[]> {
  if (!shouldAttemptSubsonicForServer(serverId)) return [];
  const scopeParams = explicitLibraryIds === undefined
    ? libraryFilterParamsForServer(serverId)
    : explicitLibraryIds.length === 0
      ? {}
      : { musicFolderId: explicitLibraryIds.length === 1 ? explicitLibraryIds[0]! : explicitLibraryIds };
  const data = await apiForServer<{ albumList2: { album: SubsonicAlbum[] } }>(
    serverId,
    'getAlbumList2.view',
    {
      type,
      size,
      offset,
      _t: Date.now(),
      ...scopeParams,
      ...extra,
    },
    timeout,
  );
  const ownerServerKey = resolveIndexKey(serverId);
  return (data.albumList2?.album ?? []).map(album => ({ ...album, serverId: ownerServerKey }));
}

export async function getSong(id: string): Promise<SubsonicSong | null> {
  if (!shouldAttemptSubsonicForActiveServer()) return null;
  try {
    const data = await api<{ song: SubsonicSong }>('getSong.view', { id });
    return data.song ?? null;
  } catch {
    return null;
  }
}

export async function getSongForServer(serverId: string, id: string): Promise<SubsonicSong | null> {
  if (!shouldAttemptSubsonicForServer(serverId, id)) return null;
  try {
    const data = await apiForServer<{ song: SubsonicSong }>(serverId, 'getSong.view', { id });
    return data.song ? { ...data.song, serverId } : null;
  } catch {
    return null;
  }
}

export type GetAlbumOptions = {
  /** When false, skip patch-on-use mirror into the local index (reconcile reads). */
  mirrorToIndex?: boolean;
};

export async function getAlbum(id: string): Promise<{ album: SubsonicAlbum; songs: SubsonicSong[] }> {
  if (!shouldAttemptSubsonicForActiveServer()) {
    throw new Error('Subsonic unavailable');
  }
  const data = await api<{ album: SubsonicAlbum & { song: SubsonicSong[] } }>('getAlbum.view', {
    id,
    ...libraryFilterParams(),
  });
  const { song, ...album } = data.album;
  const result = { album, songs: song ?? [] };
  mirrorAlbumMetadataFromServerOnUse(
    useAuthStore.getState().activeServerId,
    id,
    result.album,
  );
  return result;
}

export async function getAlbumForServer(
  serverId: string,
  id: string,
  options?: GetAlbumOptions,
): Promise<{ album: SubsonicAlbum; songs: SubsonicSong[] }> {
  if (!shouldAttemptSubsonicForServer(serverId)) {
    throw new Error('Subsonic unavailable');
  }
  const data = await apiForServer<{ album: SubsonicAlbum & { song: SubsonicSong[] } }>(
    serverId,
    'getAlbum.view',
    { id, ...libraryFilterParamsForServer(serverId) },
  );
  const { song, ...rawAlbum } = data.album;
  const album = { ...rawAlbum, serverId };
  const result = { album, songs: (song ?? []).map(entry => ({ ...entry, serverId })) };
  if (options?.mirrorToIndex !== false) {
    mirrorAlbumMetadataFromServerOnUse(serverId, id, result.album);
  }
  return result;
}
