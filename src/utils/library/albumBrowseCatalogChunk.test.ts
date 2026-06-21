import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlbumBrowseQuery } from './albumBrowseTypes';

const runLocalAlbumBrowse = vi.fn();
const fetchStarredAlbumBrowse = vi.fn();

vi.mock('./albumBrowseLocal', () => ({
  runLocalAlbumBrowse: (...args: unknown[]) => runLocalAlbumBrowse(...args),
}));

vi.mock('./albumBrowseStarredFetch', () => ({
  fetchStarredAlbumBrowse: (...args: unknown[]) => fetchStarredAlbumBrowse(...args),
}));

vi.mock('./albumBrowseNetwork', () => ({
  fetchAlbumBrowseNetwork: vi.fn(),
}));

const { fetchLocalAlbumCatalogChunk } = await import('./albumBrowseLoad');

describe('fetchLocalAlbumCatalogChunk', () => {
  const base: AlbumBrowseQuery = {
    sort: 'alphabeticalByName',
    genres: [],
    losslessOnly: false,
    starredOnly: false,
    compFilter: 'all',
  };

  beforeEach(() => {
    runLocalAlbumBrowse.mockReset();
    fetchStarredAlbumBrowse.mockReset();
    runLocalAlbumBrowse.mockResolvedValue({ albums: [], hasMore: false });
    fetchStarredAlbumBrowse.mockResolvedValue({ albums: [], hasMore: false });
  });

  it('routes starredOnly through fetchStarredAlbumBrowse, not runLocalAlbumBrowse', async () => {
    await fetchLocalAlbumCatalogChunk(
      's1',
      true,
      { ...base, starredOnly: true },
      0,
      50,
    );
    expect(fetchStarredAlbumBrowse).toHaveBeenCalledWith('s1', true, expect.objectContaining({
      starredOnly: true,
    }), 0, 50, undefined);
    expect(runLocalAlbumBrowse).not.toHaveBeenCalled();
  });

  it('uses runLocalAlbumBrowse for non-starred catalog chunks', async () => {
    await fetchLocalAlbumCatalogChunk('s1', true, { ...base, compFilter: 'only' }, 0, 50);
    expect(runLocalAlbumBrowse).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ compFilter: 'only' }),
      0,
      50,
    );
    expect(fetchStarredAlbumBrowse).not.toHaveBeenCalled();
  });
});
