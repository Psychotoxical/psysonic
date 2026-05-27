import { describe, expect, it } from 'vitest';
import {
  resolveArtistPageSongCoverArtId,
  resolvePlaybackTrackCoverArtId,
  resolveSubsonicSongCoverArtId,
} from './resolveCoverArtId';

describe('resolveSubsonicSongCoverArtId', () => {
  it('prefers albumId when coverArt is the track id', () => {
    expect(
      resolveSubsonicSongCoverArtId({
        id: 'tr-1',
        coverArt: 'tr-1',
        albumId: 'al-42',
      }),
    ).toBe('al-42');
  });
});

describe('resolvePlaybackTrackCoverArtId', () => {
  it('returns undefined for null track', () => {
    expect(resolvePlaybackTrackCoverArtId(null)).toBeUndefined();
  });

  it('resolves albumId when coverArt echoes track id', () => {
    expect(
      resolvePlaybackTrackCoverArtId({
        id: 'tr-1',
        coverArt: 'tr-1',
        albumId: 'al-42',
      }),
    ).toBe('al-42');
  });
});

describe('resolveArtistPageSongCoverArtId', () => {
  it('prefers album coverArt over song coverArt', () => {
    expect(
      resolveArtistPageSongCoverArtId(
        { id: 'tr-1', coverArt: 'tr-1', albumId: 'al-octa', album: 'Octastorium' },
        [{ id: 'al-octa', name: 'Octastorium', coverArt: 'cov-octa' }],
      ),
    ).toBe('cov-octa');
  });

  it('ignores album coverArt when it echoes track id', () => {
    expect(
      resolveArtistPageSongCoverArtId(
        { id: 'tr-1', coverArt: 'tr-1', albumId: 'al-octa', album: 'Octastorium' },
        [{ id: 'al-octa', name: 'Octastorium', coverArt: 'tr-1' }],
      ),
    ).toBe('al-octa');
  });
});
