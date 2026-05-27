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

  it('keeps coverArt when it differs from song id and albumId is set', () => {
    expect(
      resolveSubsonicSongCoverArtId({
        id: 'tr-1',
        coverArt: 'cov-track',
        albumId: 'al-42',
      }),
    ).toBe('cov-track');
  });

  it('keeps mf-* coverArt for per-disc art', () => {
    expect(
      resolveSubsonicSongCoverArtId({
        id: 'tr-1',
        coverArt: 'mf-Gg7kLxzr2dNSB7BZ9eV2Xz_69d63a8a',
        albumId: 'al-07lZYKfVt0F4MOgbhsmeyo_69d63b4d',
      }),
    ).toBe('mf-Gg7kLxzr2dNSB7BZ9eV2Xz_69d63a8a');
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

  it('uses album row coverArt when present', () => {
    expect(
      resolveArtistPageSongCoverArtId(
        {
          id: 'tr-1',
          coverArt: 'mf-x_1',
          albumId: 'al-octa_2',
          album: 'Octastorium',
        },
        [{ id: 'al-octa_2', name: 'Octastorium', coverArt: 'mf-x_1' }],
      ),
    ).toBe('mf-x_1');
  });

  it('uses per-disc coverArt when it differs from the album row', () => {
    expect(
      resolveArtistPageSongCoverArtId(
        {
          id: 'tr-2',
          coverArt: 'mf-disc2',
          albumId: 'al-box',
          album: 'Box Set',
          discNumber: 2,
        },
        [{ id: 'al-box', name: 'Box Set', coverArt: 'mf-disc1' }],
      ),
    ).toBe('mf-disc2');
  });
});
