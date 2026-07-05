import { describe, expect, it } from 'vitest';
import { filterArtistsWithRoleAlbumCredits } from './composerBrowse';

describe('filterArtistsWithRoleAlbumCredits', () => {
  it('removes artists with zero role-scoped album count', () => {
    const artists = [
      { id: '1', name: 'Bach', albumCount: 12 },
      { id: '2', name: 'Apollo 440', albumCount: 0 },
    ];
    expect(filterArtistsWithRoleAlbumCredits(artists)).toEqual([artists[0]]);
  });

  it('removes artists when role album count is missing', () => {
    const artists = [{ id: '1', name: 'Ghost', albumCount: undefined }];
    expect(filterArtistsWithRoleAlbumCredits(artists)).toEqual([]);
  });
});
