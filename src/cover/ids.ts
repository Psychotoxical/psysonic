import type { CoverArtId } from './types';

export function coverArtIdFromAlbum(album: { coverArt?: string }): CoverArtId | null {
  return album.coverArt ?? null;
}

export function coverArtIdFromSong(song: { coverArt?: string; albumId?: string }): CoverArtId | null {
  const id = song.coverArt ?? song.albumId;
  return id?.trim() || null;
}

export function coverArtIdFromArtist(artist: { coverArt?: string; id: string }): CoverArtId {
  return artist.coverArt ?? artist.id;
}

export function coverArtIdFromRadio(stationId: string): CoverArtId {
  return `ra-${stationId}`;
}
