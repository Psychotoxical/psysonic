import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import {
  fetchStatisticsLibraryAggregates,
  fetchStatisticsOverview,
  statisticsPageCacheKey,
} from '@/lib/api/subsonicStatistics';
import { getArtistsAcrossLibraries } from '@/lib/api/subsonicArtists';
import { libraryScopeCatalogStatistics, libraryScopeMostPlayedAlbums } from '@/lib/api/library';

const apiMock = vi.fn();

vi.mock('@/lib/api/subsonicClient', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api/subsonicClient')>();
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
    libraryFilterParams: () => ({}),
  };
});

vi.mock('@/lib/api/library', () => ({
  libraryScopeCatalogStatistics: vi.fn(),
  libraryScopeMostPlayedAlbums: vi.fn(),
}));

describe('statisticsPageCacheKey', () => {
  beforeEach(() => {
    useAuthStore.setState({
      activeServerId: 'srv-1',
      musicLibrarySelectionByServer: {},
      musicLibraryFilterByServer: {},
    });
  });

  it('uses all-libraries segment when nothing is selected', () => {
    expect(statisticsPageCacheKey('statsAgg')).toBe('statsAgg:srv-1:all');
  });

  it('uses comma-joined scope for multi-library selection', () => {
    useAuthStore.setState({
      musicLibrarySelectionByServer: { 'srv-1': ['lib-b', 'lib-a'] },
      musicLibraryFilterByServer: { 'srv-1': 'lib-b' },
    });
    expect(statisticsPageCacheKey('statsOverview')).toBe('statsOverview:srv-1:lib-b,lib-a');
  });

  it('accepts the ordered browse-scope fingerprint as cache provenance', () => {
    expect(statisticsPageCacheKey('statsAgg', '[["s2",null],["s1","a"]]'))
      .toBe('statsAgg:srv-1:[["s2",null],["s1","a"]]');
  });
});

describe('scope-aware statistics', () => {
  const scope = {
    serverId: 'srv-1',
    pairs: [
      { serverId: 'srv-1', libraryId: 'a' },
      { serverId: 'srv-2', libraryId: null },
    ],
    fingerprint: 'scope-1',
    multiServer: true,
  };

  beforeEach(() => {
    vi.mocked(libraryScopeCatalogStatistics).mockReset();
    vi.mocked(libraryScopeMostPlayedAlbums).mockReset();
  });

  it('uses merged catalog aggregates instead of walking the active server', async () => {
    vi.mocked(libraryScopeCatalogStatistics).mockResolvedValue({
      artistCount: 2,
      albumCount: 3,
      trackCount: 4,
      durationSec: 500,
      genres: [{ value: 'Rock', albumCount: 2, songCount: 3 }],
      formats: [],
      formatSampleSize: 0,
    });
    const result = await fetchStatisticsLibraryAggregates(scope);
    expect(result).toEqual({
      playtimeSec: 500,
      albumsCounted: 3,
      songsCounted: 4,
      capped: false,
      genres: [{ value: 'Rock', albumCount: 2, songCount: 3 }],
    });
  });

  it('builds Most Played from concrete sessions and suppresses source-bound strips', async () => {
    vi.mocked(libraryScopeMostPlayedAlbums).mockResolvedValue([{
      album: {
        serverId: 'srv-2', id: 'al-2', name: 'Album', artist: 'Artist', artistId: 'ar-2',
        syncedAt: 1, rawJson: {},
      },
      playCount: 7,
    }]);
    vi.mocked(libraryScopeCatalogStatistics).mockResolvedValue({
      artistCount: 1, albumCount: 1, trackCount: 1, durationSec: 100,
      genres: [], formats: [], formatSampleSize: 0,
    });
    const result = await fetchStatisticsOverview(scope);
    expect(result.recent).toEqual([]);
    expect(result.highest).toEqual([]);
    expect(result.frequent[0]).toMatchObject({ id: 'al-2', serverId: 'srv-2', playCount: 7 });
  });
});

describe('getArtistsAcrossLibraries', () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it('merges artists from each library without duplicate ids', async () => {
    apiMock
      .mockResolvedValueOnce({
        artists: { index: [{ artist: [{ id: 'a1', name: 'One' }] }] },
      })
      .mockResolvedValueOnce({
        artists: { index: [{ artist: [{ id: 'a1', name: 'One dup' }, { id: 'a2', name: 'Two' }] }] },
      });

    const artists = await getArtistsAcrossLibraries(['1', '2']);
    expect(artists.map(a => a.id).sort()).toEqual(['a1', 'a2']);
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(apiMock.mock.calls[0]?.[1]).toEqual({ musicFolderId: '1' });
    expect(apiMock.mock.calls[1]?.[1]).toEqual({ musicFolderId: '2' });
  });
});
