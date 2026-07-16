import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runPlaylistLoad } from '@/features/playlist/utils/runPlaylistLoad';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';

const getPlaylistMock = vi.fn();
const filterMock = vi.fn();

vi.mock('@/lib/api/subsonicPlaylists', () => ({
  getPlaylist: (id: string) => getPlaylistMock(id),
}));

vi.mock('@/lib/api/subsonicLibrary', () => ({
  filterSongsToActiveLibrary: (songs: unknown) => filterMock(songs),
}));

vi.mock('@/features/offline', () => ({
  isOfflineBrowseActive: () => false,
  resolvePlaylist: vi.fn(),
}));

vi.mock('@/features/playlist/store/playlistStore', () => ({
  usePlaylistStore: { getState: () => ({ playlists: [] }) },
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: { getState: () => ({ activeServerId: 'srv-1' }) },
}));

function makeDeps(id: string) {
  return {
    id,
    setLoading: vi.fn(),
    setPlaylist: vi.fn(),
    setSongs: vi.fn(),
    setCustomCoverId: vi.fn(),
    setRatings: vi.fn(),
    setStarredSongs: vi.fn(),
  };
}

describe('runPlaylistLoad membership seeding', () => {
  beforeEach(() => {
    getPlaylistMock.mockReset();
    filterMock.mockReset();
    usePlaylistMembershipStore.setState({ songIdsByCacheKey: {} });
  });

  it('seeds the membership cache from the full list, not the library-scoped view', async () => {
    getPlaylistMock.mockResolvedValue({
      playlist: { id: 'pl-1' },
      songs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    });
    // Active library scope hides b and c from the displayed list.
    filterMock.mockResolvedValue([{ id: 'a' }]);

    const deps = makeDeps('pl-1');
    await runPlaylistLoad(deps);

    // Cache must hold the full server membership so dedup won't re-add b/c.
    expect(usePlaylistMembershipStore.getState().getPlaylistSongIds('pl-1')).toEqual(['a', 'b', 'c']);
    // The visible list is still the filtered subset.
    expect(deps.setSongs).toHaveBeenCalledWith([{ id: 'a' }]);
  });
});
