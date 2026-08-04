import { describe, expect, it } from 'vitest';
import { resolveGenreHeaderCount } from './genreHeaderCount';

describe('resolveGenreHeaderCount', () => {
  it('does not present a partial first page as the exact album total', () => {
    expect(resolveGenreHeaderCount({
      loading: false,
      hasMore: true,
      loadedAlbumCount: 60,
      albumCount: null,
    })).toBeNull();
  });

  it('uses the loaded count when the first page exhausted the genre', () => {
    expect(resolveGenreHeaderCount({
      loading: false,
      hasMore: false,
      loadedAlbumCount: 7,
      albumCount: null,
    })).toBe(7);
  });

  it('shows a cached exact total while the album page is loading', () => {
    expect(resolveGenreHeaderCount({
      loading: true,
      hasMore: true,
      loadedAlbumCount: 0,
      albumCount: 84,
    })).toBe(84);
  });
});
