import { describe, expect, it } from 'vitest';
import {
  albumBrowseInitialLoadKey,
  fetchAlbumBrowseCatalogDeduped,
  readAlbumBrowseCatalogCache,
} from './albumBrowseInflight';
import type { AlbumBrowseQuery } from './albumBrowseTypes';

const query: AlbumBrowseQuery = {
  sort: 'alphabeticalByName',
  genres: [],
  losslessOnly: false,
  starredOnly: false,
  compFilter: 'all',
};

describe('albumBrowseInflight', () => {
  it('dedupes concurrent fetches for the same load key', async () => {
    const key = albumBrowseInitialLoadKey('srv', 1, query, false);
    let runs = 0;
    const run = () => {
      runs += 1;
      return Promise.resolve({ albums: [], hasMore: true });
    };

    const [a, b] = await Promise.all([
      fetchAlbumBrowseCatalogDeduped(key, run),
      fetchAlbumBrowseCatalogDeduped(key, run),
    ]);

    expect(runs).toBe(1);
    expect(a).toEqual(b);
    expect(readAlbumBrowseCatalogCache(key)).toEqual({ albums: [], hasMore: true });
  });
});
