// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicArtist } from '@/lib/api/subsonicTypes';
import { useArtistsBrowseCatalog } from '@/features/artist/hooks/useArtistsBrowseCatalog';
import { fetchLocalArtistCatalogChunk } from '@/lib/library/browseTextSearch';
import { clearArtistBrowseCatalogCache } from '@/lib/library/artistBrowseInflight';

vi.mock('@/lib/library/browseTextSearch', () => ({
  fetchLocalArtistCatalogChunk: vi.fn(),
}));

vi.mock('@/features/artist/utils/artistBrowseCreditMode', () => ({
  fetchNetworkArtistCatalog: vi.fn(async () => []),
  fetchStarredArtistsForBrowse: vi.fn(async () => []),
}));

vi.mock('@/features/offline', () => ({
  fetchOfflineLocalArtistCatalogChunk: vi.fn(async () => null),
  fetchOfflineLocalStarredArtists: vi.fn(async () => []),
  offlineLocalBrowseEnabled: vi.fn(() => false),
  useOfflineBrowseContext: () => ({ active: false }),
  useOfflineBrowseReloadToken: () => 0,
}));

vi.mock('@/store/localPlaybackBrowseRevision', () => ({
  useOfflineLocalBrowseReloadKey: () => 0,
}));

vi.mock('@/store/offlineLocalLibrarySyncRevision', () => ({
  useOfflineLocalLibrarySyncRevision: () => 0,
}));

vi.mock('@/lib/library/artistBrowseDebug', () => ({
  artistBrowseTimed: vi.fn(async (_step: string, run: () => Promise<unknown>) => run()),
  emitArtistsBrowseDebug: vi.fn(),
}));

const artists = Array.from({ length: 60 }, (_, index) => ({
  id: `artist-${index}`,
  name: `Artist ${index}`,
})) as SubsonicArtist[];

const args = {
  serverId: 'srv-1',
  indexEnabled: true,
  starredOnly: false,
  creditMode: 'album' as const,
  letterFilter: 'ALL',
  musicLibraryFilterVersion: 0,
  libraryScopeKey: 'srv-1',
  libraryScopes: [{ serverId: 'srv-1', libraryId: null }],
  multiServer: false,
};

describe('useArtistsBrowseCatalog bootstrap', () => {
  beforeEach(() => {
    clearArtistBrowseCatalogCache();
    vi.mocked(fetchLocalArtistCatalogChunk).mockReset().mockResolvedValue({
      artists,
      hasMore: true,
    });
  });

  it('keeps the bootstrap page until scrolling requests more and reuses it on remount', async () => {
    const first = renderHook(() => useArtistsBrowseCatalog(args));

    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.catalogArtists).toHaveLength(60);
    expect(first.result.current.catalogHasMore).toBe(true);
    expect(fetchLocalArtistCatalogChunk).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderHook(() => useArtistsBrowseCatalog(args));

    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(second.result.current.catalogArtists).toHaveLength(60);
    expect(fetchLocalArtistCatalogChunk).toHaveBeenCalledTimes(1);
  });
});
