// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useSongBrowseList } from '@/features/search/hooks/useSongBrowseList';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';

vi.mock('@/lib/api/subsonicSearch', () => ({
  searchSongsPaged: vi.fn(async () => []),
}));

vi.mock('@/lib/api/navidromeBrowse', () => ({
  ndListSongs: vi.fn(async () => []),
}));

vi.mock('@/lib/library/advancedSearchLocal', () => ({
  runLocalSongBrowse: vi.fn(async () => []),
}));

// Only the reload-token hook was stubbed pre-move (its own module); mock that
// submodule directly so the barrel re-exports the stub while the real
// `useOfflineBrowseContext` (a different submodule) stays live.
vi.mock('@/features/offline/hooks/useOfflineBrowseReloadToken', () => ({
  useOfflineBrowseReloadToken: () => undefined,
}));

vi.mock('@/lib/library/browseTextSearch', () => ({
  BROWSE_TEXT_DEBOUNCE_NETWORK_MS: 10,
  BROWSE_TEXT_DEBOUNCE_RACE_MS: 10,
  browseRaceCountsSongs: vi.fn(),
  loadMoreLocalBrowseSongs: vi.fn(async () => []),
  raceBrowseWithLocalFallback: vi.fn(async () => null),
  runLocalBrowseSongPage: vi.fn(async () => []),
  runNetworkBrowseSongPage: vi.fn(async () => [{ id: 'fresh' } as SubsonicSong]),
}));

const stashedSong = { id: 'stashed', title: 'Stashed', artist: 'A', duration: 180 } as SubsonicSong;

describe('useSongBrowseList restore hold', () => {
  beforeEach(() => {
    useAuthStore.setState({ activeServerId: 'srv-1' });
    useLibraryIndexStore.setState({ masterEnabled: true });
  });

  it('keeps stashed songs after fetchSongPage identity changes until query edits', async () => {
    const { result, rerender } = renderHook(
      ({ searchQuery }) => useSongBrowseList({
        enabled: true,
        searchQuery,
        initialRestore: {
          query: 'jazz',
          songs: [stashedSong],
          offset: 1,
          hasMore: false,
          localSearchMode: true,
          browseUnsupported: false,
          hasSearched: true,
        },
      }),
      { initialProps: { searchQuery: 'jazz' } },
    );

    expect(result.current.songs).toEqual([stashedSong]);

    rerender({ searchQuery: 'jazz' });
    await waitFor(() => {
      expect(result.current.songs).toEqual([stashedSong]);
    }, { timeout: 500 });

    rerender({ searchQuery: 'jazzx' });
    await waitFor(() => {
      expect(result.current.songs[0]?.id).toBe('fresh');
    }, { timeout: 500 });
  });
});
