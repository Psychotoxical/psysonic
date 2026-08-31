import { describe, it, expect } from 'vitest';
import { albumExportCoverRef } from './export';
import { albumCoverRef } from '../ref';

describe('albumExportCoverRef', () => {
  it('keeps an already-prefixed Navidrome coverArt id intact', () => {
    // Regression: passing coverArt as both ids rewrote this to `al-al-abc123_0`,
    // which no server resolves — every exported tile rendered as an empty panel.
    const ref = albumExportCoverRef({ id: 'abc123', coverArt: 'al-abc123' });
    expect(ref?.fetchCoverArtId).toBe('al-abc123');
    expect(ref?.cacheEntityId).toBe('abc123');
  });

  it('lands on the same cache slot as the album cards', () => {
    expect(albumExportCoverRef({ id: 'abc123', coverArt: 'al-abc123' }))
      .toEqual(albumCoverRef('abc123', 'al-abc123'));
  });

  it('derives the Navidrome fetch id when the server sends no coverArt', () => {
    expect(albumExportCoverRef({ id: 'abc123' })?.fetchCoverArtId).toBe('al-abc123_0');
  });

  it('returns null when the album carries no usable id', () => {
    expect(albumExportCoverRef({ id: '', coverArt: '' })).toBeNull();
  });
});
