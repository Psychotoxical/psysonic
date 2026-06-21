import type { LibraryTrackDto } from '../../api/library';
import { libraryAdvancedSearch, libraryGetTracksBatchChunked, libraryGetTracksByAlbum } from '../../api/library';
import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '../../api/subsonicTypes';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';
import type { LocalPlaybackEntry } from '../../store/localPlaybackStore';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import {
  albumToAlbum,
  artistToArtist,
  resolveTrackCoverArtId,
  trackToSong,
} from '../library/advancedSearchLocal';
import { albumIsCompilationFromTrackDtos } from '../library/albumCompilation';
import {
  filterAlbumsByCompilation,
  filterAlbumsByGenres,
  filterAlbumsByStarred,
  filterAlbumsByYearBounds,
} from '../library/albumBrowseFilters';
import type { AlbumBrowseQuery } from '../library/albumBrowseTypes';
import { sortSubsonicAlbums } from '../library/albumBrowseSort';
import { isLosslessSuffix } from '../library/losslessFormats';
import { entryBelongsToServer } from './offlineLibraryHelpers';

function sortBrowsableSongs(songs: SubsonicSong[]): SubsonicSong[] {
  return [...songs].sort((a, b) => a.title.localeCompare(b.title));
}

function listBrowsableEntries(serverId: string): LocalPlaybackEntry[] {
  return Object.values(useLocalPlaybackStore.getState().entries).filter(
    e => (e.tier === 'library' || e.tier === 'favorite-auto')
      && !!e.localPath
      && entryBelongsToServer(e, serverId),
  );
}

export function countLocalBrowsableTracks(serverId: string): number {
  return listBrowsableEntries(serverId).length;
}

/** Local library index + at least one on-disk library/favorites track for this server. */
export function offlineLocalBrowseEnabled(serverId: string | null | undefined): boolean {
  if (!serverId) return false;
  if (!useLibraryIndexStore.getState().isIndexEnabled(serverId)) return false;
  return countLocalBrowsableTracks(serverId) > 0;
}

/** Track DTOs for every library/favorite-auto entry with on-disk bytes for this server. */
export async function fetchBrowsableLocalTrackDtos(serverId: string): Promise<LibraryTrackDto[]> {
  const entries = listBrowsableEntries(serverId);
  if (entries.length === 0) return [];
  const refs = entries.map(e => ({ serverId, trackId: e.trackId }));
  return libraryGetTracksBatchChunked(refs);
}

export function buildAlbumFromTracks(
  albumId: string,
  tracks: LibraryTrackDto[],
  serverId: string,
): SubsonicAlbum {
  const songs = tracks.map(trackToSong).map(s => ({ ...s, serverId }));
  const first = tracks[0];
  const starred = tracks.some(t => t.starredAt != null);
  const isCompilation = albumIsCompilationFromTrackDtos(tracks);
  return {
    id: albumId,
    name: first.album ?? albumId,
    artist: first.albumArtist ?? first.artist ?? '',
    artistId: first.artistId ?? '',
    coverArt: resolveTrackCoverArtId(first) ?? albumId,
    year: first.year ?? undefined,
    genre: first.genre ?? undefined,
    songCount: songs.length,
    duration: songs.reduce((sum, s) => sum + (s.duration ?? 0), 0),
    starred: starred ? new Date().toISOString() : undefined,
    isCompilation: isCompilation || undefined,
    serverId,
  };
}

function aggregateAlbumsFromTracks(
  tracks: LibraryTrackDto[],
  serverId: string,
): SubsonicAlbum[] {
  const byAlbum = new Map<string, LibraryTrackDto[]>();
  for (const track of tracks) {
    const albumId = track.albumId;
    if (!albumId) continue;
    const list = byAlbum.get(albumId) ?? [];
    list.push(track);
    byAlbum.set(albumId, list);
  }
  return [...byAlbum.entries()].map(([albumId, albumTracks]) =>
    buildAlbumFromTracks(albumId, albumTracks, serverId),
  );
}

function aggregateArtistsFromTracks(
  tracks: LibraryTrackDto[],
  serverId: string,
): SubsonicArtist[] {
  const albumIdsByArtist = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  for (const track of tracks) {
    const artistId = track.artistId;
    if (!artistId) continue;
    names.set(artistId, track.artist ?? track.albumArtist ?? artistId);
    const set = albumIdsByArtist.get(artistId) ?? new Set<string>();
    if (track.albumId) set.add(track.albumId);
    albumIdsByArtist.set(artistId, set);
  }
  return [...names.entries()]
    .map(([id, name]) => ({
      id,
      name,
      albumCount: albumIdsByArtist.get(id)?.size ?? 0,
      serverId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function applyAlbumBrowseQuery(
  albums: SubsonicAlbum[],
  query: AlbumBrowseQuery,
  starredOverrides: Record<string, boolean>,
): SubsonicAlbum[] {
  let out = albums;
  if (query.genres.length > 0) {
    out = filterAlbumsByGenres(out, query.genres);
  }
  if (query.year) {
    out = filterAlbumsByYearBounds(out, query.year);
  }
  if (query.starredOnly) {
    out = filterAlbumsByStarred(out, starredOverrides);
  }
  if (query.compFilter !== 'all') {
    out = filterAlbumsByCompilation(out, query.compFilter);
  }
  return sortSubsonicAlbums(out, query.sort);
}

export async function fetchOfflineLocalBrowsableSongPage(
  serverId: string,
  offset: number,
  chunkSize: number,
): Promise<{ songs: SubsonicSong[]; hasMore: boolean } | null> {
  if (!offlineLocalBrowseEnabled(serverId)) return null;
  const tracks = await fetchBrowsableLocalTrackDtos(serverId);
  const songs = sortBrowsableSongs(
    tracks.map(trackToSong).map(s => ({ ...s, serverId })),
  );
  const slice = songs.slice(offset, offset + chunkSize);
  return { songs: slice, hasMore: offset + chunkSize < songs.length };
}

export async function searchOfflineLocalBrowsableSongs(
  serverId: string,
  query: string,
  offset: number,
  chunkSize: number,
): Promise<SubsonicSong[] | null> {
  if (!offlineLocalBrowseEnabled(serverId)) return null;
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const tracks = await fetchBrowsableLocalTrackDtos(serverId);
  const matched = tracks
    .filter(t =>
      (t.title?.toLowerCase().includes(q))
      || (t.artist?.toLowerCase().includes(q))
      || (t.album?.toLowerCase().includes(q)),
    )
    .map(trackToSong)
    .map(s => ({ ...s, serverId }));
  return sortBrowsableSongs(matched).slice(offset, offset + chunkSize);
}

export async function fetchOfflineLocalStarredArtists(serverId: string): Promise<SubsonicArtist[] | null> {
  if (!offlineLocalBrowseEnabled(serverId)) return null;
  const tracks = (await fetchBrowsableLocalTrackDtos(serverId)).filter(t => t.starredAt != null);
  return aggregateArtistsFromTracks(tracks, serverId);
}

export async function fetchOfflineLocalArtistCatalogChunk(
  serverId: string,
  offset: number,
  chunkSize: number,
): Promise<{ artists: SubsonicArtist[]; hasMore: boolean } | null> {
  if (!offlineLocalBrowseEnabled(serverId)) return null;
  const tracks = await fetchBrowsableLocalTrackDtos(serverId);
  const artists = aggregateArtistsFromTracks(tracks, serverId);
  const slice = artists.slice(offset, offset + chunkSize);
  return {
    artists: slice,
    hasMore: offset + chunkSize < artists.length,
  };
}

export async function searchOfflineLocalArtists(
  serverId: string,
  query: string,
): Promise<SubsonicArtist[] | null> {
  if (!offlineLocalBrowseEnabled(serverId)) return null;
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tracks = await fetchBrowsableLocalTrackDtos(serverId);
  return aggregateArtistsFromTracks(tracks, serverId)
    .filter(a => a.name.toLowerCase().includes(q));
}

export async function fetchOfflineLocalAlbumCatalogChunk(
  serverId: string,
  query: AlbumBrowseQuery,
  offset: number,
  chunkSize: number,
  starredOverrides: Record<string, boolean> = {},
): Promise<{ albums: SubsonicAlbum[]; hasMore: boolean } | null> {
  if (!offlineLocalBrowseEnabled(serverId)) return null;
  let tracks = await fetchBrowsableLocalTrackDtos(serverId);
  if (query.losslessOnly) {
    tracks = tracks.filter(t => isLosslessSuffix(t.suffix ?? undefined));
  }
  let albums = aggregateAlbumsFromTracks(tracks, serverId);
  albums = applyAlbumBrowseQuery(albums, query, starredOverrides);
  const slice = albums.slice(offset, offset + chunkSize);
  return {
    albums: slice,
    hasMore: offset + chunkSize < albums.length,
  };
}

export async function searchOfflineLocalAlbums(
  serverId: string,
  query: string,
  losslessOnly = false,
): Promise<SubsonicAlbum[] | null> {
  if (!offlineLocalBrowseEnabled(serverId)) return null;
  const q = query.trim().toLowerCase();
  if (!q) return [];
  let tracks = await fetchBrowsableLocalTrackDtos(serverId);
  if (losslessOnly) {
    tracks = tracks.filter(t => isLosslessSuffix(t.suffix ?? undefined));
  }
  return aggregateAlbumsFromTracks(tracks, serverId)
    .filter(a => a.name.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q));
}

export async function loadAlbumFromLocalPlayback(
  serverId: string,
  albumId: string,
): Promise<{ album: SubsonicAlbum; songs: SubsonicSong[] } | null> {
  if (!offlineLocalBrowseEnabled(serverId)) return null;
  const localIds = new Set(listBrowsableEntries(serverId).map(e => e.trackId));
  const tracks = await libraryGetTracksByAlbum(serverId, albumId);
  const localTracks = tracks.filter(t => localIds.has(t.id));
  if (localTracks.length === 0) return null;

  const songs = localTracks.map(trackToSong).map(s => ({ ...s, serverId }));
  const albumSearch = await libraryAdvancedSearch({
    serverId,
    entityTypes: ['album'],
    restrictAlbumIds: [albumId],
    limit: 1,
  }).catch(() => null);
  const albumDto = albumSearch?.albums[0];
  const album = albumDto
    ? { ...albumToAlbum(albumDto), serverId, songCount: songs.length }
    : buildAlbumFromTracks(albumId, localTracks, serverId);

  return {
    album: {
      ...album,
      duration: songs.reduce((sum, s) => sum + (s.duration ?? 0), 0),
    },
    songs,
  };
}

export async function loadArtistFromLocalPlayback(
  serverId: string,
  artistId: string,
): Promise<{ artist: SubsonicArtist; albums: SubsonicAlbum[] } | null> {
  if (!offlineLocalBrowseEnabled(serverId)) return null;
  const localIds = new Set(listBrowsableEntries(serverId).map(e => e.trackId));
  const tracks = (await fetchBrowsableLocalTrackDtos(serverId)).filter(
    t => t.artistId === artistId && localIds.has(t.id),
  );
  if (tracks.length === 0) return null;

  const albums = aggregateAlbumsFromTracks(tracks, serverId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const artistDto = tracks[0];
  const artistSearch = await libraryAdvancedSearch({
    serverId,
    entityTypes: ['artist'],
    limit: 10_000,
  }).catch(() => null);
  const match = artistSearch?.artists.find(a => a.id === artistId);

  const artist = match
    ? { ...artistToArtist(match), serverId, albumCount: albums.length }
    : {
      id: artistId,
      name: artistDto.artist ?? artistDto.albumArtist ?? artistId,
      albumCount: albums.length,
      serverId,
    };

  return { artist, albums };
}
