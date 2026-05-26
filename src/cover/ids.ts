import type { CoverArtId } from './types';

export function coverArtIdFromAlbum(album: { coverArt?: string }): CoverArtId | null {
  return album.coverArt ?? null;
}

export function coverArtIdFromSong(song: { coverArt?: string; id?: string }): CoverArtId | null {
  return song.coverArt ?? null;
}

export function coverArtIdFromArtist(artist: { coverArt?: string; id: string }): CoverArtId {
  return artist.coverArt ?? artist.id;
}

export function coverArtIdFromRadio(stationId: string): CoverArtId {
  return `ra-${stationId}`;
}
