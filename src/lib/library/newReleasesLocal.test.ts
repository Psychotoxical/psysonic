import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLocalNewReleases } from '@/lib/library/newReleasesLocal';

const libraryScopeListMainstageAlbums = vi.fn();

vi.mock('@/lib/api/library/scopeReads', () => ({
  libraryScopeListMainstageAlbums: (...args: unknown[]) => libraryScopeListMainstageAlbums(...args),
}));

describe('loadLocalNewReleases', () => {
  beforeEach(() => libraryScopeListMainstageAlbums.mockReset());

  it('keeps globally ordered owner-stamped rows from the local feed', async () => {
    libraryScopeListMainstageAlbums.mockResolvedValue({
      albums: [
        { serverId: 'server-b', id: 'newer', name: 'Newer', syncedAt: 1, rawJson: {} },
        { serverId: 'server-a', id: 'older', name: 'Older', syncedAt: 1, rawJson: {} },
      ],
      hasMore: true,
    });

    const result = await loadLocalNewReleases('server-a', [
      { serverId: 'server-a', libraryId: 'a1' },
      { serverId: 'server-b', libraryId: 'b1' },
    ], 30, 60);

    expect(libraryScopeListMainstageAlbums).toHaveBeenCalledWith('server-a', {
      scopes: [{ serverId: 'server-a', libraryId: 'a1' }, { serverId: 'server-b', libraryId: 'b1' }],
      feed: 'newReleases',
      limit: 30,
      offset: 60,
      genres: [],
      includeGenreCounts: false,
    });
    expect(result.albums.map(album => [album.serverId, album.id])).toEqual([
      ['server-b', 'newer'],
      ['server-a', 'older'],
    ]);
    expect(result.hasMore).toBe(true);
  });

  it('skips IPC for an empty selected scope', async () => {
    await expect(loadLocalNewReleases('', [], 30)).resolves.toEqual({
      albums: [], hasMore: false, genreCounts: [],
    });
    expect(libraryScopeListMainstageAlbums).not.toHaveBeenCalled();
  });

  it('reads the whole fallback server when defensive scope pairs are empty', async () => {
    libraryScopeListMainstageAlbums.mockResolvedValue({
      albums: [],
      hasMore: false,
      genreCounts: [],
    });

    await loadLocalNewReleases('server-a', [], 30);

    expect(libraryScopeListMainstageAlbums).toHaveBeenCalledWith('server-a', {
      scopes: [{ serverId: 'server-a', libraryId: null }],
      feed: 'newReleases',
      limit: 30,
      offset: 0,
      genres: [],
      includeGenreCounts: false,
    });
  });

  // The count query costs ~100x the feed it accompanies and every browse read
  // shares one connection, so it has to be asked for, never assumed.
  it('leaves genre counts off unless the caller asks for them', async () => {
    libraryScopeListMainstageAlbums.mockResolvedValue({ albums: [], hasMore: false, genreCounts: [] });

    await loadLocalNewReleases('server-a', [{ serverId: 'server-a', libraryId: 'a1' }], 30, 0, []);
    expect(libraryScopeListMainstageAlbums.mock.calls[0][1].includeGenreCounts).toBe(false);

    await loadLocalNewReleases('server-a', [{ serverId: 'server-a', libraryId: 'a1' }], 30, 0, [], true);
    expect(libraryScopeListMainstageAlbums.mock.calls[1][1].includeGenreCounts).toBe(true);
  });
});
