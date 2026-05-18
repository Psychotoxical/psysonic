import { describe, expect, it } from 'vitest';
import { deriveAlbumArtistRefs, deriveAlbumHeaderArtistRefs } from './deriveAlbumHeaderArtistRefs';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import { makeSubsonicSong } from '@/test/helpers/factories';

const baseAlbum = (): SubsonicAlbum => ({
  id: 'al-1',
  name: 'Test Album',
  artist: 'Joined A / B',
  artistId: 'ar-first',
  songCount: 2,
  duration: 100,
});

describe('deriveAlbumArtistRefs', () => {
  it('prefers the OpenSubsonic `artists` array when present', () => {
    const album: SubsonicAlbum = {
      ...baseAlbum(),
      artists: [{ id: 'a1', name: 'One' }, { id: 'a2', name: 'Two' }],
    };
    expect(deriveAlbumArtistRefs(album)).toEqual(album.artists);
  });

  it('uses legacy artist + artistId when no structured refs', () => {
    expect(deriveAlbumArtistRefs(baseAlbum())).toEqual([{ id: 'ar-first', name: 'Joined A / B' }]);
  });

  it('omits id when artistId is blank', () => {
    expect(deriveAlbumArtistRefs({ ...baseAlbum(), artistId: '   ', artist: 'Solo' }))
      .toEqual([{ name: 'Solo' }]);
  });
});

describe('deriveAlbumHeaderArtistRefs', () => {
  it('prefers the album-level `artists` array when present', () => {
    const album: SubsonicAlbum = {
      ...baseAlbum(),
      artists: [{ id: 'a1', name: 'One' }, { id: 'a2', name: 'Two' }],
    };
    expect(deriveAlbumHeaderArtistRefs(album, [])).toEqual(album.artists);
  });

  it('falls back to the first song with `albumArtists`', () => {
    const album = baseAlbum();
    const songs = [
      makeSubsonicSong({
        albumId: album.id,
        album: album.name,
        albumArtists: [{ id: 'b1', name: 'Beta' }, { name: 'Gamma' }],
      }),
    ];
    expect(deriveAlbumHeaderArtistRefs(album, songs)).toEqual(songs[0].albumArtists);
  });

  it('uses legacy artist + artistId when no structured refs', () => {
    const album = baseAlbum();
    const songs = [makeSubsonicSong({ albumId: album.id, album: album.name })];
    expect(deriveAlbumHeaderArtistRefs(album, songs)).toEqual([{ id: 'ar-first', name: 'Joined A / B' }]);
  });

  it('omits id when artistId is blank', () => {
    const album: SubsonicAlbum = { ...baseAlbum(), artistId: '   ', artist: 'Solo' };
    expect(deriveAlbumHeaderArtistRefs(album, [])).toEqual([{ name: 'Solo' }]);
  });
});
