import { libraryAdvancedSearch, libraryGetTracksByAlbum } from '@/lib/api/library';
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
