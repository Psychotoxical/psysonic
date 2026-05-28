import { describe, expect, it } from 'vitest';
import { topSongAlbumForCover, topSongAlbumsForCoverWarm } from './topSongAlbumForCover';

describe('topSongAlbumForCover', () => {
  it('uses the artist album row when albumId matches', () => {
    expect(
      topSongAlbumForCover(
        { albumId: 'al-1', album: 'Grid Name', coverArt: 'tr-1' },
        [{ id: 'al-1', name: 'Grid Name', coverArt: 'cov-grid' }],
      ),
    ).toEqual({ id: 'al-1', name: 'Grid Name', coverArt: 'cov-grid' });
  });

  it('falls back to song fields when the album is not in the discography list', () => {
    expect(
      topSongAlbumForCover(
        { albumId: 'al-feat', album: 'Compilation', coverArt: 'cov-feat' },
        [{ id: 'al-other', name: 'Other', coverArt: 'cov-other' }],
      ),
    ).toEqual({ id: 'al-feat', name: 'Compilation', coverArt: 'cov-feat' });
  });

  it('returns null without albumId', () => {
    expect(topSongAlbumForCover({ albumId: '', album: 'X', coverArt: 'c' }, [])).toBeNull();
  });
});

describe('topSongAlbumsForCoverWarm', () => {
  it('dedupes by album id', () => {
    expect(
      topSongAlbumsForCoverWarm(
        [
          { albumId: 'al-1', album: 'A', coverArt: 'c1' },
          { albumId: 'al-1', album: 'A', coverArt: 'c1' },
          { albumId: 'al-2', album: 'B', coverArt: 'c2' },
        ],
        [{ id: 'al-1', name: 'A', coverArt: 'cov-a' }],
      ),
    ).toEqual([
      { id: 'al-1', coverArt: 'cov-a' },
      { id: 'al-2', coverArt: 'c2' },
    ]);
  });
});
