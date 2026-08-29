import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { fetchHotNewReleases, mergeHotNewReleases } from './hotNewReleases';

const getAlbumListForServer = vi.fn();
const libraryResolveAlbumOverlay = vi.fn();
vi.mock('@/lib/api/subsonicLibrary', () => ({
  getAlbumListForServer: (...args: unknown[]) => getAlbumListForServer(...args),
}));
vi.mock('@/lib/api/library/scopeReads', () => ({
  libraryResolveAlbumOverlay: (...args: unknown[]) => libraryResolveAlbumOverlay(...args),
}));

function album(id: string, created: string, serverId = 's1'): SubsonicAlbum {
  return { id, created, serverId, name: id, artist: 'Artist', artistId: 'artist', songCount: 1, duration: 1 };
}

describe('hot New Releases overlay', () => {
  beforeEach(() => {
    getAlbumListForServer.mockReset();
    libraryResolveAlbumOverlay.mockReset();
  });

  it('keeps the local representative while collapsing physical copies', () => {
    const merged = mergeHotNewReleases(
      [album('canonical', '2026-01-01T00:00:00Z', 's1')],
      [
        {
          album: album('alternate', '2026-01-03T00:00:00Z', 's1'),
          group: 0,
          representativeServerId: 's1',
          representativeId: 'canonical',
        },
        {
          album: album('other-server-copy', '2026-01-04T00:00:00Z', 's2'),
          group: 0,
          representativeServerId: 's1',
          representativeId: 'canonical',
        },
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      serverId: 's1',
      id: 'canonical',
      created: '2026-01-04T00:00:00Z',
    });
  });

  it('collapses unindexed hot copies by their request-local identity group', () => {
    const merged = mergeHotNewReleases([], [
      { album: album('older', '2026-01-02T00:00:00Z', 's1'), group: 3 },
      { album: album('newer', '2026-01-03T00:00:00Z', 's2'), group: 3 },
      { album: album('distinct', '2026-01-01T00:00:00Z', 's2'), group: 4 },
    ]);
    expect(merged.map(item => item.id)).toEqual(['newer', 'distinct']);
  });

  it('uses the canonical owner when the local first page does not contain it', () => {
    const merged = mergeHotNewReleases([], [{
      album: album('fresh-copy', '2026-01-03T00:00:00Z', 's2'),
      group: 0,
      representativeServerId: 's1',
      representativeId: 'canonical',
    }]);

    expect(merged).toEqual([expect.objectContaining({
      serverId: 's1',
      id: 'canonical',
      created: '2026-01-03T00:00:00Z',
    })]);
  });

  it('requests each selected library and keeps only recent valid dates', async () => {
    const now = Date.parse('2026-07-16T12:00:00Z');
    getAlbumListForServer.mockImplementation(async (serverId: string) => {
      const fresh = album(`${serverId}-fresh`, '2026-07-16T11:00:00Z', serverId);
      if (serverId === 's1') fresh.version = 'Deluxe Edition';
      else fresh.tags = { albumversion: ['[Remaster]'] };
      return [
        fresh,
        album(`${serverId}-old`, '2026-07-12T11:00:00Z', serverId),
        album(`${serverId}-invalid`, 'not-a-date', serverId),
      ];
    });
    libraryResolveAlbumOverlay.mockImplementation(async ({ albums }: { albums: SubsonicAlbum[] }) => (
      albums.map((_item, group) => ({
        group,
        representativeServerId: null,
        representativeId: null,
      }))
    ));

    const result = await fetchHotNewReleases([
      { serverId: 's1', libraryId: 'l1' },
      { serverId: 's2', libraryId: 'l2' },
    ], now);

    expect(getAlbumListForServer).toHaveBeenCalledWith(
      's1', 'newest', 24, 0, { musicFolderId: 'l1' }, 8000,
    );
    expect(getAlbumListForServer).toHaveBeenCalledWith(
      's2', 'newest', 24, 0, { musicFolderId: 'l2' }, 8000,
    );
    expect(libraryResolveAlbumOverlay).toHaveBeenCalledWith({
      scopes: [
        { serverId: 's1', libraryId: 'l1' },
        { serverId: 's2', libraryId: 'l2' },
      ],
      albums: [
        {
          serverId: 's1',
          id: 's1-fresh',
          name: 's1-fresh',
          artist: 'Artist',
          version: 'Deluxe Edition',
        },
        {
          serverId: 's2', id: 's2-fresh', name: 's2-fresh', artist: 'Artist', version: '[Remaster]',
        },
      ],
    });
    expect(result.map(item => item.album.id).sort()).toEqual(['s1-fresh', 's2-fresh']);
  });

  it('normalizes scalar and mixed albumversion tags without dropping the overlay', async () => {
    const now = Date.parse('2026-07-16T12:00:00Z');
    const variants = [
      { id: 'scalar', tags: { albumversion: 'Deluxe' }, expected: 'Deluxe' },
      { id: 'mixed', tags: { albumversion: [null, 7, '', 'Remaster'] }, expected: 'Remaster' },
      { id: 'null', tags: { albumversion: null }, expected: null },
      { id: 'malformed', tags: 'unexpected', expected: null },
    ];
    getAlbumListForServer.mockResolvedValue(variants.map(({ id, tags }) => ({
      ...album(id, '2026-07-16T11:00:00Z'),
      tags,
    })));
    libraryResolveAlbumOverlay.mockImplementation(async ({ albums }: { albums: Array<{ version: string | null }> }) => (
      albums.map((_item, group) => ({ group, representativeServerId: null, representativeId: null }))
    ));

    await fetchHotNewReleases([{ serverId: 's1', libraryId: 'l1' }], now);

    expect(libraryResolveAlbumOverlay).toHaveBeenCalledWith({
      scopes: [{ serverId: 's1', libraryId: 'l1' }],
      albums: variants.map(({ id, expected }) => ({
        serverId: 's1',
        id,
        name: id,
        artist: 'Artist',
        version: expected,
      })),
    });
  });
});
