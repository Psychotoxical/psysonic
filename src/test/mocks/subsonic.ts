/**
 * Subsonic API mock fixtures.
 *
 * `vi.mock('@/api/subsonic')` is hoisted in the test file itself (vitest
 * limitation — factory functions can't reach helper modules at hoist time).
 * This module supplies the *data* the test injects into those mocks:
 *
 *   // In the test:
 *   vi.mock('@/api/subsonic');
 *   import { getAlbum, buildStreamUrl } from '@/api/subsonic';
 *   import { sampleAlbumWithSongs, mockStreamUrl } from '@/test/mocks/subsonic';
 *
 *   beforeEach(() => {
 *     vi.mocked(getAlbum).mockResolvedValue(sampleAlbumWithSongs);
 *     vi.mocked(buildStreamUrl).mockImplementation(mockStreamUrl);
 *   });
 *
 * Realistic shape matters more than perfect coverage — these fixtures
 * mirror what Navidrome actually returns for common queries.
 */
import type { SubsonicSong, SubsonicAlbum, SubsonicPlaylist } from '@/api/subsonicTypes';
import { makeSubsonicSong } from '@/test/helpers/factories';

export const sampleSubsonicSong: SubsonicSong = makeSubsonicSong({
  id: 'song-1',
  title: 'Sample Song',
  artist: 'Sample Artist',
  album: 'Sample Album',
  albumId: 'album-1',
  artistId: 'artist-1',
});

export const sampleEmptyAlbum: SubsonicAlbum = {
  id: 'album-empty',
  name: 'Empty Album',
  artist: 'Sample Artist',
  artistId: 'artist-1',
  songCount: 0,
  duration: 0,
};

export const sampleAlbumWithSong: SubsonicAlbum & { song: SubsonicSong } = {
  id: 'album-single',
  name: 'Single-Song Album',
  artist: 'Sample Artist',
  artistId: 'artist-1',
  coverArt: 'album-single',
  songCount: 1,
  duration: 180,
  year: 2024,
  song: sampleSubsonicSong,
};

export const sampleAlbumWithSongs: SubsonicAlbum & { song: SubsonicSong[] } = {
  id: 'album-multi',
  name: 'Multi-Track Album',
  artist: 'Sample Artist',
  artistId: 'artist-1',
  coverArt: 'album-multi',
  songCount: 3,
  duration: 540,
  year: 2024,
  genre: 'Rock',
  song: [
    makeSubsonicSong({ id: 'song-m1', title: 'Track 1', album: 'Multi-Track Album', albumId: 'album-multi', track: 1 }),
    makeSubsonicSong({ id: 'song-m2', title: 'Track 2', album: 'Multi-Track Album', albumId: 'album-multi', track: 2 }),
    makeSubsonicSong({ id: 'song-m3', title: 'Track 3', album: 'Multi-Track Album', albumId: 'album-multi', track: 3 }),
  ],
};

export const samplePlaylist: SubsonicPlaylist = {
  id: 'pl-1',
  name: 'Sample Playlist',
  songCount: 2,
  duration: 360,
  created: '2026-01-01T00:00:00Z',
  changed: '2026-01-15T00:00:00Z',
  owner: 'tester',
  public: false,
  coverArt: 'pl-1',
};

export function mockStreamUrl(id: string): string {
  return `https://mock.subsonic.test/rest/stream.view?id=${encodeURIComponent(id)}`;
}

export function mockCoverArtUrl(id: string, size = 256): string {
  return `https://mock.subsonic.test/rest/getCoverArt.view?id=${encodeURIComponent(id)}&size=${size}`;
}

export function mockCoverArtCacheKey(id: string, size = 256): string {
  return `mock-server:cover:${id}:${size}`;
}

/** Generic Subsonic error shape for tests asserting failure paths. */
export class MockSubsonicError extends Error {
  constructor(message: string, public readonly code = 40) {
    super(message);
    this.name = 'MockSubsonicError';
  }
}
