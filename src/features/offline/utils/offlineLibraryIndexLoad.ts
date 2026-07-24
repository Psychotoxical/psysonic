import {
  libraryAdvancedSearch,
  libraryGetTracksByAlbum,
  libraryScopeArtistDetail,
} from '@/lib/api/library';
import { libraryScopeForServer, libraryScopePairsForServer } from '@/lib/api/subsonicClient';
import type {
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicSong,
} from '@/lib/api/subsonicTypes';
import {
  albumToAlbum,
  artistToArtist,
  trackToSong,
} from '@/lib/library/advancedSearchLocal';

type ArtistIndexLoad = {
  artist: SubsonicArtist;
  /** The artist's own discography (main grid). */
  albums: SubsonicAlbum[];
  /** Albums the artist only appears on. Kept separate so the artist page can render
   *  the split offline; legacy all-album consumers union the two arrays. */
  appearsOnAlbums: SubsonicAlbum[];
} | null;
type AlbumIndexLoad = { album: SubsonicAlbum; songs: SubsonicSong[] } | null;

const albumIndexLoads = new Map<string, Promise<AlbumIndexLoad>>();
const artistIndexLoads = new Map<string, Promise<ArtistIndexLoad>>();
const artistTrackLoads = new Map<string, Promise<SubsonicSong[] | null>>();

function artistScopes(serverId: string) {
  const selectedScopes = libraryScopePairsForServer(serverId);
  const fallbackScope = libraryScopeForServer(serverId);
  return selectedScopes.length > 0
    ? selectedScopes
    : fallbackScope ? [{ serverId, libraryId: fallbackScope }] : [];
}

export function loadAlbumFromLibraryIndex(
  serverId: string,
  albumId: string,
): Promise<AlbumIndexLoad> {
  const key = `${serverId}\u0000${albumId}`;
  const existing = albumIndexLoads.get(key);
  if (existing) return existing;

  const load = loadAlbumFromLibraryIndexImpl(serverId, albumId)
    .finally(() => albumIndexLoads.delete(key));
  albumIndexLoads.set(key, load);
  return load;
}

async function loadAlbumFromLibraryIndexImpl(
  serverId: string,
  albumId: string,
): Promise<AlbumIndexLoad> {
  const tracks = await libraryGetTracksByAlbum(serverId, albumId);
  if (tracks.length === 0) return null;

  const songs = tracks.map(trackToSong);
  const albumSearch = await libraryAdvancedSearch({
    serverId,
    entityTypes: ['album'],
    restrictAlbumIds: [albumId],
    limit: 1,
    skipTotals: true,
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
      starred: undefined,
      serverId,
    },
    songs: songs.map(s => ({ ...s, serverId })),
  };
}

export async function loadArtistFromLibraryIndex(
  serverId: string,
  artistId: string,
): Promise<ArtistIndexLoad> {
  const scopes = artistScopes(serverId);

  if (scopes.length > 0) {
    const key = `${serverId}\u0000${artistId}\u0000${scopes.map(scope => `${scope.serverId}:${scope.libraryId}`).join(',')}`;
    const existing = artistIndexLoads.get(key);
    if (existing) return existing;

    const load = libraryScopeArtistDetail(serverId, {
      scopes,
      artistId,
      serverId,
      includeTracks: false,
    })
      .then(response => response.artist.id ? {
        artist: artistToArtist(response.artist),
        // Keep the split intact so the artist page can render "appears on" offline;
        // legacy all-album consumers union the two arrays themselves.
        albums: response.albums
          .map(albumToAlbum)
          .map(album => ({ ...album, serverId })),
        appearsOnAlbums: response.appearsOnAlbums
          .map(albumToAlbum)
          .map(album => ({ ...album, serverId })),
      } : null)
      .finally(() => artistIndexLoads.delete(key));
    artistIndexLoads.set(key, load);
    return load;
  }

  const response = await libraryAdvancedSearch({
    serverId,
    entityTypes: ['album', 'artist'],
    limit: 10_000,
    skipTotals: true,
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
    // The all-library search fallback has no scoped split to work from.
    appearsOnAlbums: [],
  };
}

/** Scoped artist tracks for Now Playing. Avoids one indexed album read per discography entry. */
export async function loadArtistTracksFromLibraryIndex(
  serverId: string,
  artistId: string,
): Promise<SubsonicSong[] | null> {
  const scopes = artistScopes(serverId);
  if (scopes.length === 0) return null;

  const key = `${serverId}\u0000${artistId}\u0000${scopes.map(scope => `${scope.serverId}:${scope.libraryId}`).join(',')}`;
  const existing = artistTrackLoads.get(key);
  if (existing) return existing;

  const load = libraryScopeArtistDetail(serverId, {
    scopes,
    artistId,
    serverId,
    includeTracks: true,
  })
    .then(response => response.artist.id ? response.tracks.map(trackToSong) : null)
    .finally(() => artistTrackLoads.delete(key));
  artistTrackLoads.set(key, load);
  return load;
}
