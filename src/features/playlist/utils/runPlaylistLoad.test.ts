import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runPlaylistLoad } from '@/features/playlist/utils/runPlaylistLoad';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';

const getPlaylistForServerMock = vi.fn();
const filterMock = vi.fn();

vi.mock('@/lib/api/subsonicPlaylists', () => ({
  getPlaylistForServer: (serverId: string, id: string) => getPlaylistForServerMock(serverId, id),
}));

vi.mock('@/lib/api/subsonicLibrary', () => ({
  filterSongsToServerLibrary: (songs: unknown, serverId: string) => filterMock(songs, serverId),
}));

vi.mock('@/features/offline', () => ({
  isOfflineBrowseActive: () => false,
  resolvePlaylist: vi.fn(),
}));

vi.mock('@/features/playlist/store/playlistStore', () => ({
  usePlaylistStore: { getState: () => ({ playlists: [] }) },
}));

function makeDeps(id: string, ownerServerId = 'srv-1') {
  return {
    id,
    ownerServerId,
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
    getPlaylistForServerMock.mockReset();
    filterMock.mockReset();
    usePlaylistMembershipStore.setState({ songIdsByCacheKey: {} });
  });

  it('seeds the membership cache from the full list, not the library-scoped view', async () => {
    getPlaylistForServerMock.mockResolvedValue({
      playlist: { id: 'pl-1' },
      songs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    });
    // Active library scope hides b and c from the displayed list.
    filterMock.mockResolvedValue([{ id: 'a' }]);

    const deps = makeDeps('pl-1');
    await runPlaylistLoad(deps);

    // Cache must hold the full server membership so dedup won't re-add b/c.
    expect(getPlaylistForServerMock).toHaveBeenCalledWith('srv-1', 'pl-1');
    expect(filterMock).toHaveBeenCalledWith(expect.any(Array), 'srv-1');
    expect(usePlaylistMembershipStore.getState().getPlaylistSongIds('pl-1', 'srv-1')).toEqual(['a', 'b', 'c']);
    // The visible list is still the filtered subset.
    expect(deps.setSongs).toHaveBeenCalledWith([{ id: 'a' }]);
  });

  it('keeps equal playlist ids isolated by owner server', async () => {
    getPlaylistForServerMock.mockImplementation(async (serverId: string) => ({
      playlist: { id: 'same', serverId },
      songs: [{ id: `${serverId}-song`, serverId }],
    }));
    filterMock.mockImplementation(async (songs: unknown) => songs);

    await runPlaylistLoad(makeDeps('same', 'srv-a'));
    await runPlaylistLoad(makeDeps('same', 'srv-b'));

    expect(usePlaylistMembershipStore.getState().getPlaylistSongIds('same', 'srv-a')).toEqual(['srv-a-song']);
    expect(usePlaylistMembershipStore.getState().getPlaylistSongIds('same', 'srv-b')).toEqual(['srv-b-song']);
  });
});
