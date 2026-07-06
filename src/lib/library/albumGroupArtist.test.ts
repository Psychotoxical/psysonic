import { describe, expect, it } from 'vitest';
import type { LibraryTrackDto } from '@/lib/api/library';
import {
  pickAlbumGroupArtist,
  pickAlbumGroupArtistFromTrackDtos,
  resolveAlbumCreditArtistId,
} from '@/lib/library/albumGroupArtist';

function track(
  overrides: Partial<LibraryTrackDto> & Pick<LibraryTrackDto, 'id'>,
): LibraryTrackDto {
  return {
    serverId: 'srv-a',
    title: 'Song',
    album: 'Album',
    durationSec: 1,
    syncedAt: 1,
    rawJson: {},
    ...overrides,
  };
}

describe('albumGroupArtist', () => {
  it('pickAlbumGroupArtist prefers albumArtist over track performer', () => {
    expect(pickAlbumGroupArtist('Guest', 'Headliner')).toBe('Headliner');
    expect(pickAlbumGroupArtist('Guest', '  ')).toBe('Guest');
  });

  it('pickAlbumGroupArtistFromTrackDtos uses MIN(artist) when albumArtist absent', () => {
    const tracks = [
      track({ id: 't2', artist: 'Zebra' }),
      track({ id: 't1', artist: 'Alpha' }),
    ];
    expect(pickAlbumGroupArtistFromTrackDtos(tracks)).toBe('Alpha');
  });

  it('pickAlbumGroupArtistFromTrackDtos uses MAX(albumArtist) when present on any track', () => {
    const tracks = [
      track({ id: 't1', albumArtist: 'Alpha', artist: 'A' }),
      track({ id: 't2', albumArtist: 'Zulu', artist: 'B' }),
    ];
    expect(pickAlbumGroupArtistFromTrackDtos(tracks)).toBe('Zulu');
  });

  it('resolveAlbumCreditArtistId prefers performer row matching credit name', () => {
    const tracks = [
      track({ id: 't1', artist: 'Guest', artistId: 'art-guest', albumArtist: 'Headliner' }),
      track({ id: 't2', artist: 'Headliner', artistId: 'art-head', albumArtist: 'Headliner' }),
    ];
    expect(resolveAlbumCreditArtistId(tracks, 'Headliner')).toBe('art-head');
  });
});
