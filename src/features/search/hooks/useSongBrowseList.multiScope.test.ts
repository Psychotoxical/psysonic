import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';

const runLocalSongBrowseMock = vi.fn();
const ndListSongsMock = vi.fn();
const searchSongsPagedMock = vi.fn();

vi.mock('@/lib/library/advancedSearchLocal', () => ({
  runLocalSongBrowse: (...args: unknown[]) => runLocalSongBrowseMock(...args),
}));
vi.mock('@/lib/api/navidromeBrowse', () => ({
  ndListSongs: (...args: unknown[]) => ndListSongsMock(...args),
}));
vi.mock('@/lib/api/subsonicSearch', () => ({
  searchSongsPaged: (...args: unknown[]) => searchSongsPagedMock(...args),
}));
vi.mock('@/features/offline', () => ({
  fetchOfflineLocalBrowsableSongPage: vi.fn(),
  offlineLocalBrowseEnabled: () => false,
  searchOfflineLocalBrowsableSongs: vi.fn(),
  useOfflineBrowseContext: () => ({ active: false }),
  useOfflineBrowseReloadToken: () => 0,
}));
vi.mock('@/store/localPlaybackBrowseRevision', () => ({
  useOfflineLocalBrowseReloadKey: () => '',
}));
vi.mock('@/store/useBrowseLibraryScope', () => ({
  useBrowseLibraryScope: () => ({
    pairs: [{ serverId: 's1', libraryId: 'a' }, { serverId: 's2', libraryId: null }],
    fingerprint: 'multi',
    anchorServerId: 's1',
    configuredServerIds: ['s1', 's2'],
    multiServer: true,
  }),
}));

import { useSongBrowseList } from './useSongBrowseList';

describe('useSongBrowseList multi-server mode', () => {
  beforeEach(() => {
    runLocalSongBrowseMock.mockReset().mockResolvedValue(null);
    ndListSongsMock.mockReset();
    searchSongsPagedMock.mockReset();
    useAuthStore.setState({ activeServerId: 's1', musicLibraryFilterVersion: 0 });
    useLibraryIndexStore.setState({ masterEnabled: true });
  });

  it('keeps browse-all local-only when the merged index has no page', async () => {
    const { result } = renderHook(() => useSongBrowseList({ enabled: true, searchQuery: '' }));
    await waitFor(() => expect(result.current.hasSearched).toBe(true));
    expect(runLocalSongBrowseMock).toHaveBeenCalledWith(
      's1',
      0,
      50,
      [{ serverId: 's1', libraryId: 'a' }, { serverId: 's2', libraryId: null }],
    );
    expect(ndListSongsMock).not.toHaveBeenCalled();
    expect(searchSongsPagedMock).not.toHaveBeenCalled();
  });
});
