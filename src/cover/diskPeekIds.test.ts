import { describe, expect, it } from 'vitest';
import { diskCoverArtIdCandidates } from './diskPeekIds';

describe('diskCoverArtIdCandidates', () => {
  it('lists resolved id first then legacy disk folder ids', () => {
    expect(
      diskCoverArtIdCandidates('al-42', {
        rawCoverArt: 'tr-1',
        albumCoverArt: 'cov-grid',
        albumId: 'al-42',
        songId: 'tr-1',
      }),
    ).toEqual(['al-42', 'tr-1', 'cov-grid']);
  });

  it('dedupes identical hints', () => {
    expect(
      diskCoverArtIdCandidates('tr-1', {
        rawCoverArt: 'tr-1',
        songId: 'tr-1',
        albumId: 'al-1',
      }),
    ).toEqual(['tr-1', 'al-1']);
  });
});
