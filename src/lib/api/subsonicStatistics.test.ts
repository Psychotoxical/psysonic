import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { statisticsPageCacheKey } from '@/lib/api/subsonicStatistics';
import { getArtistsAcrossLibraries } from '@/lib/api/subsonicArtists';

const apiMock = vi.fn();

vi.mock('@/lib/api/subsonicClient', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api/subsonicClient')>();
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
    libraryFilterParams: () => ({}),
  };
});

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
