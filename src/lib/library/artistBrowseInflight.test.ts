import { describe, expect, it } from 'vitest';
import {
  artistBrowseBootstrapEligible,
  artistBrowseCatalogCacheKey,
  artistBrowseInitialLoadKey,
  fetchArtistBrowseCatalogDeduped,
  readArtistBrowseCatalogCache,
} from './artistBrowseInflight';

describe('artistBrowseInflight', () => {
  it('builds stable load keys', () => {
    const key = artistBrowseInitialLoadKey('srv', 2, 'lib1,lib2', 'album', 'ALL', false, false);
    expect(key).toBe('srv|2|lib1,lib2|online|album|ALL|false');
  });

  it('dedupes concurrent fetches for the same key', async () => {
    const key = 'dedupe-test';
    let runs = 0;
    const run = () => {
      runs += 1;
      return Promise.resolve({ artists: [{ id: 'a1', name: 'A' }], hasMore: false });
    };
    const [a, b] = await Promise.all([
      fetchArtistBrowseCatalogDeduped(key, run),
      fetchArtistBrowseCatalogDeduped(key, run),
    ]);
    expect(runs).toBe(1);
    expect(a).toEqual(b);
    expect(readArtistBrowseCatalogCache(key)?.artists).toHaveLength(1);
  });

  it('uses boot cache key suffix for bootstrap chunks', () => {
    const loadKey = artistBrowseInitialLoadKey('srv', 0, 'all', 'album', 'ALL', false, false);
    expect(artistBrowseCatalogCacheKey(loadKey, 60, 200)).toBe(`${loadKey}|boot:60`);
    expect(artistBrowseCatalogCacheKey(loadKey, 200, 200)).toBe(loadKey);
  });

  it('bootstrap is only for unfiltered all-artists browse', () => {
    expect(artistBrowseBootstrapEligible('ALL', false)).toBe(true);
    expect(artistBrowseBootstrapEligible('A', false)).toBe(false);
    expect(artistBrowseBootstrapEligible('ALL', true)).toBe(false);
  });
});
