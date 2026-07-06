import type { ArtistCreditMode, LibraryTrackDto } from '@/lib/api/library';
import { libraryAdvancedSearch, libraryGetTracksBatchChunked, libraryGetTracksByAlbum } from '@/lib/api/library';
import type { SubsonicAlbum, SubsonicArtist, SubsonicGenre, SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import type { LocalPlaybackEntry } from '@/store/localPlaybackStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import {
  albumToAlbum,
  resolveTrackCoverArtId,
  trackToSong,
} from '@/lib/library/advancedSearchLocal';
import { albumIsCompilationFromTrackDtos } from '@/lib/library/albumCompilation';
import {
  countGenresFromAlbums,
  filterAlbumsByCompilation,
  filterAlbumsByGenres,
  filterAlbumsByStarred,
  filterAlbumsByYearBounds,
} from '@/lib/library/albumBrowseFilters';
import type { AlbumBrowseQuery, GenreFilterOption } from '@/lib/library/albumBrowseTypes';
import { sortSubsonicAlbums } from '@/lib/library/albumBrowseSort';
import {
  pickAlbumGroupArtistFromTrackDtos,
  resolveAlbumCreditArtistId,
} from '@/lib/library/albumGroupArtist';
import { artistLetterBucket } from '@/lib/library/artistLetterBucket';
import { isLosslessSuffix } from '@/lib/library/losslessFormats';
import { hasBrowsableLocalPlaybackBytes } from '@/lib/localPlayback/browsablePlaybackTiers';
import { offlineLocalLibrarySyncRevision } from '@/store/offlineLocalLibrarySyncRevision';
import { resolveIndexKey } from '@/lib/server/serverIndexKey';
import { entryBelongsToServer } from '@/store/localPlaybackResolve';

function sortBrowsableSongs(songs: SubsonicSong[]): SubsonicSong[] {
  return [...songs].sort((a, b) => a.title.localeCompare(b.title));
}


function listBrowsableEntries(
  serverId: string,
  entries: Record<string, LocalPlaybackEntry> = useLocalPlaybackStore.getState().entries,
): LocalPlaybackEntry[] {
  return Object.values(entries).filter(
    e => hasBrowsableLocalPlaybackBytes(e) && entryBelongsToServer(e, serverId),
  );
}

export function countLocalBrowsableTracks(
  serverId: string,
  entries?: Record<string, LocalPlaybackEntry>,
): number {
  return listBrowsableEntries(serverId, entries).length;
}

/** Local library index + at least one on-disk library, favorites-auto, or hot-cache track. */
export function offlineLocalBrowseEnabled(
  serverId: string | null | undefined,
  entries?: Record<string, LocalPlaybackEntry>,
): boolean {
  if (!serverId) return false;
  if (!useLibraryIndexStore.getState().isIndexEnabled(serverId)) return false;
  return countLocalBrowsableTracks(serverId, entries) > 0;
}

function browsableEntriesRevision(serverId: string): string {
  const filterVer = useAuthStore.getState().musicLibraryFilterVersion;
  const syncRev = offlineLocalLibrarySyncRevision(serverId);
  const entries = listBrowsableEntries(serverId)
    .map(e => `${e.trackId}:${e.cachedAt}`)
    .sort()
    .join('\0');
  return `${filterVer}\0${syncRev}\0${entries}`;
}

type BrowsableTrackCache = {
  serverId: string;
  revision: string;
  tracks: LibraryTrackDto[];
};

let browsableTrackCache: BrowsableTrackCache | null = null;

/** Drop cached on-disk track DTOs after library resync or pin set changes. */
export function invalidateBrowsableLocalTrackCache(serverId?: string): void {
  if (!browsableTrackCache) return;
  if (!serverId) {
    browsableTrackCache = null;
    return;
  }
  const cachedId = browsableTrackCache.serverId;
  if (
    cachedId === serverId
    || resolveIndexKey(cachedId) === serverId
    || resolveIndexKey(serverId) === cachedId
  ) {
    browsableTrackCache = null;
  }
}

/** Test-only reset. */
export function resetBrowsableLocalTrackCacheForTests(): void {
  browsableTrackCache = null;
}

/** Track DTOs for every library/favorite-auto entry with on-disk bytes for this server. */
export async function fetchBrowsableLocalTrackDtos(serverId: string): Promise<LibraryTrackDto[]> {
  const revision = browsableEntriesRevision(serverId);
  if (
    browsableTrackCache?.serverId === serverId
    && browsableTrackCache.revision === revision
  ) {
    return browsableTrackCache.tracks;
  }
  const entries = listBrowsableEntries(serverId);
  if (entries.length === 0) {
    browsableTrackCache = { serverId, revision, tracks: [] };
    return [];
  }
  const refs = entries.map(e => ({ serverId, trackId: e.trackId }));
  const tracks = await libraryGetTracksBatchChunked(refs);
  browsableTrackCache = { serverId, revision, tracks };
  return tracks;
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
  const creditName = pickAlbumGroupArtistFromTrackDtos(tracks);
  const artistId = resolveAlbumCreditArtistId(tracks, creditName);
  return {
    id: albumId,
    name: first.album ?? albumId,
    artist: creditName,
    artistId,
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

/** Album credit groups by album artist; track credit groups by track performer id. */
function aggregateArtistsFromTracksForCreditMode(
  tracks: LibraryTrackDto[],
  serverId: string,
  creditMode: ArtistCreditMode,
): SubsonicArtist[] {
  if (creditMode === 'track') {
    return aggregateArtistsFromTracks(tracks, serverId);
  }
  const byAlbum = new Map<string, LibraryTrackDto[]>();
  for (const track of tracks) {
    const albumId = track.albumId;
    if (!albumId) continue;
    const list = byAlbum.get(albumId) ?? [];
    list.push(track);
    byAlbum.set(albumId, list);
  }
  const byArtistId = new Map<string, { name: string; albumIds: Set<string> }>();
  for (const [albumId, albumTracks] of byAlbum) {
    const creditName = pickAlbumGroupArtistFromTrackDtos(albumTracks);
    const artistId = resolveAlbumCreditArtistId(albumTracks, creditName);
    if (!artistId) continue;
    const entry = byArtistId.get(artistId) ?? { name: creditName, albumIds: new Set<string>() };
    entry.albumIds.add(albumId);
    byArtistId.set(artistId, entry);
  }
  return [...byArtistId.entries()]
    .map(([id, { name, albumIds }]) => ({
      id,
      name,
      albumCount: albumIds.size,
      serverId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function starredIsoFromTrackTimestamps(timestamps: number[]): string {
  const max = timestamps.length > 0 ? Math.max(...timestamps) : Date.now();
  return new Date(max).toISOString();
}

function attachStarredFromTracks(
  artists: SubsonicArtist[],
  tracks: LibraryTrackDto[],
  creditMode: ArtistCreditMode,
): SubsonicArtist[] {
  const starredAtByArtistId = new Map<string, number[]>();
  if (creditMode === 'track') {
    for (const track of tracks) {
      if (!track.artistId || track.starredAt == null) continue;
      const list = starredAtByArtistId.get(track.artistId) ?? [];
      list.push(track.starredAt);
      starredAtByArtistId.set(track.artistId, list);
    }
  } else {
    const byAlbum = new Map<string, LibraryTrackDto[]>();
    for (const track of tracks) {
      const albumId = track.albumId;
      if (!albumId) continue;
      const list = byAlbum.get(albumId) ?? [];
      list.push(track);
      byAlbum.set(albumId, list);
    }
    for (const albumTracks of byAlbum.values()) {
      const artistId = resolveAlbumCreditArtistId(
        albumTracks,
        pickAlbumGroupArtistFromTrackDtos(albumTracks),
      );
      if (!artistId) continue;
      const starredTs = albumTracks
        .map(t => t.starredAt)
        .filter((v): v is number => v != null);
      if (starredTs.length === 0) continue;
      const list = starredAtByArtistId.get(artistId) ?? [];
      list.push(...starredTs);
      starredAtByArtistId.set(artistId, list);
    }
  }
  return artists.map(artist => ({
    ...artist,
    starred: starredIsoFromTrackTimestamps(starredAtByArtistId.get(artist.id) ?? []),
  }));
}

function localTracksForArtist(
  tracks: LibraryTrackDto[],
  artistId: string,
  serverId: string,
  creditMode: ArtistCreditMode,
): LibraryTrackDto[] {
  if (creditMode === 'track') {
    return tracks.filter(t => t.artistId === artistId);
  }
  const albumIds = new Set(
    aggregateAlbumsFromTracks(tracks, serverId)
      .filter(a => a.artistId === artistId)
      .map(a => a.id),
  );
  return tracks.filter(t => t.albumId && albumIds.has(t.albumId));
}

function resolveLocalArtistTracks(
  allTracks: LibraryTrackDto[],
  artistId: string,
  serverId: string,
  creditMode?: ArtistCreditMode,
): { tracks: LibraryTrackDto[]; creditMode: ArtistCreditMode } {
  const preferred = creditMode ?? useAuthStore.getState().artistBrowseCreditMode;
  let tracks = localTracksForArtist(allTracks, artistId, serverId, preferred);
  if (tracks.length > 0) {
    return { tracks, creditMode: preferred };
  }
  const alternate: ArtistCreditMode = preferred === 'album' ? 'track' : 'album';
  tracks = localTracksForArtist(allTracks, artistId, serverId, alternate);
  if (tracks.length > 0) {
    return { tracks, creditMode: alternate };
  }
  return { tracks: [], creditMode: preferred };
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

export async function fetchOfflineLocalStarredArtists(
  serverId: string,
  creditMode: ArtistCreditMode = 'album',
): Promise<SubsonicArtist[] | null> {
  if (!offlineLocalBrowseEnabled(serverId)) return null;
  const tracks = (await fetchBrowsableLocalTrackDtos(serverId)).filter(t => t.starredAt != null);
  return attachStarredFromTracks(
    aggregateArtistsFromTracksForCreditMode(tracks, serverId, creditMode),
    tracks,
    creditMode,
  );
}

function filterArtistsByLetterBucket(
  artists: SubsonicArtist[],
  letterBucket?: string | null,
  ignoredArticles?: string | null,
): SubsonicArtist[] {
  if (!letterBucket || letterBucket === 'ALL') return artists;
  return artists.filter(a => artistLetterBucket(a, ignoredArticles) === letterBucket);
}

export async function fetchOfflineLocalArtistCatalogChunk(
  serverId: string,
  offset: number,
  chunkSize: number,
  creditMode: ArtistCreditMode = 'album',
  letterBucket?: string | null,
  ignoredArticles?: string | null,
): Promise<{ artists: SubsonicArtist[]; hasMore: boolean } | null> {
  if (!offlineLocalBrowseEnabled(serverId)) return null;
  const tracks = await fetchBrowsableLocalTrackDtos(serverId);
  const artists = filterArtistsByLetterBucket(
    aggregateArtistsFromTracksForCreditMode(tracks, serverId, creditMode),
    letterBucket,
    ignoredArticles,
  );
  const slice = artists.slice(offset, offset + chunkSize);
  return {
    artists: slice,
    hasMore: offset + chunkSize < artists.length,
  };
}

export async function searchOfflineLocalArtists(
  serverId: string,
  query: string,
  creditMode: ArtistCreditMode = 'album',
): Promise<SubsonicArtist[] | null> {
  if (!offlineLocalBrowseEnabled(serverId)) return null;
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tracks = await fetchBrowsableLocalTrackDtos(serverId);
  return aggregateArtistsFromTracksForCreditMode(tracks, serverId, creditMode)
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

/** Genre filter dropdown options from on-disk albums only (offline All Albums). */
export async function fetchOfflineLocalAlbumGenreOptions(
  serverId: string,
  query: AlbumBrowseQuery,
  starredOverrides: Record<string, boolean> = {},
): Promise<GenreFilterOption[]> {
  if (!offlineLocalBrowseEnabled(serverId)) return [];
  let tracks = await fetchBrowsableLocalTrackDtos(serverId);
  if (query.losslessOnly) {
    tracks = tracks.filter(t => isLosslessSuffix(t.suffix ?? undefined));
  }
  let albums = aggregateAlbumsFromTracks(tracks, serverId);
  albums = applyAlbumBrowseQuery(albums, { ...query, genres: [] }, starredOverrides);
  return countGenresFromAlbums(filterAlbumsByCompilation(albums, query.compFilter));
}

/** Genres cloud from on-disk albums only (offline browse). */
export async function fetchOfflineLocalGenreCatalog(serverId: string): Promise<SubsonicGenre[]> {
  if (!offlineLocalBrowseEnabled(serverId)) return [];
  const options = await fetchOfflineLocalAlbumGenreOptions(serverId, {
    sort: 'alphabeticalByName',
    genres: [],
    losslessOnly: false,
    starredOnly: false,
    compFilter: 'all',
  });
  return options.map(o => ({
    value: o.genre,
    albumCount: o.count,
    songCount: 0,
  }));
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
  creditMode?: ArtistCreditMode,
): Promise<{ artist: SubsonicArtist; albums: SubsonicAlbum[] } | null> {
  if (!offlineLocalBrowseEnabled(serverId)) return null;
  const localIds = new Set(listBrowsableEntries(serverId).map(e => e.trackId));
  const allTracks = (await fetchBrowsableLocalTrackDtos(serverId)).filter(t => localIds.has(t.id));
  const { tracks, creditMode: effectiveCreditMode } = resolveLocalArtistTracks(
    allTracks,
    artistId,
    serverId,
    creditMode,
  );
  if (tracks.length === 0) return null;

  const albums = aggregateAlbumsFromTracks(tracks, serverId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const catalogMatch = aggregateArtistsFromTracksForCreditMode(allTracks, serverId, effectiveCreditMode)
    .find(a => a.id === artistId)
    ?? aggregateArtistsFromTracksForCreditMode(allTracks, serverId, effectiveCreditMode === 'album' ? 'track' : 'album')
      .find(a => a.id === artistId);
  const fallback = tracks[0];

  const artist: SubsonicArtist = catalogMatch
    ? { ...catalogMatch, albumCount: albums.length }
    : {
      id: artistId,
      name: fallback.artist ?? fallback.albumArtist ?? artistId,
      albumCount: albums.length,
      serverId,
    };

  return { artist, albums };
}
