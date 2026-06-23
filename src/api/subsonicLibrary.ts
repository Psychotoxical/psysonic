import { useAuthStore } from '../store/authStore';
import {
  shouldAttemptSubsonicForActiveServer,
  shouldAttemptSubsonicForServer,
} from '../utils/network/subsonicNetworkGuard';
import { api, apiForServer, libraryFilterParams, libraryFilterParamsForServer } from './subsonicClient';
import type {
  RandomSongsFilters,
  SubsonicAlbum,
  SubsonicDirectory,
  SubsonicDirectoryEntry,
  SubsonicMusicFolder,
  SubsonicSong,
} from './subsonicTypes';

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
  type IndexArtist = { id: string; name: string; coverArt?: string };
  type IndexEntry  = { name: string; artist?: IndexArtist | IndexArtist[] };
  const data = await api<{ indexes: { index?: IndexEntry | IndexEntry[] } }>(
    'getIndexes.view',
    { musicFolderId },
  );
  const raw = data.indexes?.index;
  if (!raw) return [];
  const indices = Array.isArray(raw) ? raw : [raw];
  const entries: SubsonicDirectoryEntry[] = [];
  for (const idx of indices) {
    const artists = idx.artist ? (Array.isArray(idx.artist) ? idx.artist : [idx.artist]) : [];
    for (const a of artists) {
      entries.push({ id: a.id, title: a.name, isDir: true, coverArt: a.coverArt });
    }
  }
  return entries;
}

export async function getMusicFolders(): Promise<SubsonicMusicFolder[]> {
  const data = await api<{ musicFolders: { musicFolder: SubsonicMusicFolder | SubsonicMusicFolder[] } }>(
    'getMusicFolders.view',
  );
  const raw = data.musicFolders?.musicFolder;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map(f => ({
    id: String((f as { id: string | number }).id),
    name: (f as { name?: string }).name ?? 'Library',
  }));
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
  const folder = musicLibraryFilterByServer[serverId];
  if (folder === undefined || folder === 'all') {
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
export function similarSongsRequestCount(desired: number): number {
  const { activeServerId, musicLibraryFilterByServer } = useAuthStore.getState();
  const f = activeServerId ? musicLibraryFilterByServer[activeServerId] : undefined;
  if (f === undefined || f === 'all') return desired;
  return Math.min(300, Math.max(desired, desired * 4));
}

export async function getRandomSongs(size = 50, genre?: string, timeout = 15000): Promise<SubsonicSong[]> {
  const params: Record<string, string | number> = { size, _t: Date.now(), ...libraryFilterParams() };
  if (genre) params.genre = genre;
  const data = await api<{ randomSongs: { song: SubsonicSong[] } }>('getRandomSongs.view', params, timeout);
  return data.randomSongs?.song ?? [];
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
): Promise<SubsonicAlbum[]> {
  if (!shouldAttemptSubsonicForServer(serverId)) return [];
  const data = await apiForServer<{ albumList2: { album: SubsonicAlbum[] } }>(serverId, 'getAlbumList2.view', {
    type,
    size,
    offset,
    _t: Date.now(),
    ...libraryFilterParamsForServer(serverId),
    ...extra,
  });
  return data.albumList2?.album ?? [];
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
    return data.song ?? null;
  } catch {
    return null;
  }
}

export async function getAlbum(id: string): Promise<{ album: SubsonicAlbum; songs: SubsonicSong[] }> {
  if (!shouldAttemptSubsonicForActiveServer()) {
    throw new Error('Subsonic unavailable');
  }
  const data = await api<{ album: SubsonicAlbum & { song: SubsonicSong[] } }>('getAlbum.view', { id });
  const { song, ...album } = data.album;
  return { album, songs: song ?? [] };
}

export async function getAlbumForServer(
  serverId: string,
  id: string,
): Promise<{ album: SubsonicAlbum; songs: SubsonicSong[] }> {
  if (!shouldAttemptSubsonicForServer(serverId)) {
    throw new Error('Subsonic unavailable');
  }
  const data = await apiForServer<{ album: SubsonicAlbum & { song: SubsonicSong[] } }>(serverId, 'getAlbum.view', { id });
  const { song, ...album } = data.album;
  return { album, songs: song ?? [] };
}
