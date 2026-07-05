import { afterEach, describe, expect, it } from 'vitest';
import {
  genreCatalogCacheKey,
  invalidateGenreCatalogCache,
  lookupGenreAlbumCount,
  peekGenreCatalogCache,
  resetGenreCatalogCountsCacheForTests,
  writeGenreCatalogCache,
} from './genreCatalogCountsCache';

describe('genreCatalogCountsCache', () => {
  afterEach(() => {
    resetGenreCatalogCountsCacheForTests();
  });

  it('keys by server and library scope', () => {
    expect(genreCatalogCacheKey('srv-1', undefined)).toBe('srv-1:all');
    expect(genreCatalogCacheKey('srv-1', 'lib-a')).toBe('srv-1:lib-a');
  });

  it('serves fresh and stale catalog entries', () => {
    const genres = [{ value: 'Rock', albumCount: 3, songCount: 10 }];
    writeGenreCatalogCache('srv-1', 'lib-a', genres);
    expect(peekGenreCatalogCache('srv-1', 'lib-a')).toEqual(genres);
    expect(peekGenreCatalogCache('srv-1', 'lib-a', true)).toEqual(genres);
    expect(peekGenreCatalogCache('srv-1', 'lib-b')).toBeNull();
  });

  it('looks up album counts from cached catalog', () => {
    writeGenreCatalogCache('srv-1', 'all', [
      { value: 'Rock', albumCount: 12, songCount: 40 },
    ]);
    expect(lookupGenreAlbumCount('srv-1', 'rock', 'all')).toBe(12);
    expect(lookupGenreAlbumCount('srv-1', 'Jazz', 'all')).toBeNull();
  });

  it('invalidates per server', () => {
    writeGenreCatalogCache('srv-1', 'all', [{ value: 'A', albumCount: 1, songCount: 1 }]);
    writeGenreCatalogCache('srv-2', 'all', [{ value: 'B', albumCount: 2, songCount: 2 }]);
    invalidateGenreCatalogCache('srv-1');
    expect(peekGenreCatalogCache('srv-1', 'all')).toBeNull();
    expect(peekGenreCatalogCache('srv-2', 'all')).not.toBeNull();
  });
});
