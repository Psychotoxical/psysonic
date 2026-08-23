import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runPlaylistLoad } from '@/features/playlist/utils/runPlaylistLoad';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';

const getPlaylistForServerMock = vi.fn();
const filterMock = vi.fn();
const playlistStoreState = vi.hoisted(() => ({ playlists: [] as Array<Record<string, unknown>> }));

vi.mock('@/lib/api/subsonicPlaylists', () => ({
  getPlaylist: vi.fn(),
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
  usePlaylistStore: { getState: () => playlistStoreState },
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: { getState: () => ({ activeServerId: 'srv-1' }) },
}));

function makeDeps(id: string) {
  return {
    id,
    serverId: 'srv-1',
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
    playlistStoreState.playlists = [];
    usePlaylistMembershipStore.setState({ songIdsByCacheKey: {}, revision: 0 });
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
    expect(usePlaylistMembershipStore.getState().getPlaylistSongIds('pl-1', 'srv-1')).toEqual(['a', 'b', 'c']);
    // The visible list is still the filtered subset.
    expect(deps.setSongs).toHaveBeenCalledWith([{ id: 'a', serverId: 'srv-1' }]);
  });

  it('preserves authoritative smart metadata from the playlist list', async () => {
    playlistStoreState.playlists = [{ id: 'smart', serverId: 'srv-1', name: 'Native smart', smart: true }];
    getPlaylistForServerMock.mockResolvedValue({
      playlist: { id: 'smart', name: 'Native smart' },
      songs: [],
    });
    filterMock.mockResolvedValue([]);

    const deps = makeDeps('smart');
    await runPlaylistLoad(deps);

    expect(deps.setPlaylist).toHaveBeenCalledWith(expect.objectContaining({
      id: 'smart',
      serverId: 'srv-1',
      smart: true,
    }));
  });

  it('does not apply a stale response after the route owner changes', async () => {
    let resolveRequest!: (value: { playlist: { id: string }; songs: { id: string }[] }) => void;
    getPlaylistForServerMock.mockReturnValue(new Promise(resolve => {
      resolveRequest = resolve;
    }));
    filterMock.mockImplementation(async songs => songs);
    let current = true;
    const deps = { ...makeDeps('shared'), isCurrent: () => current };

    const load = runPlaylistLoad(deps);
    current = false;
    resolveRequest({ playlist: { id: 'shared' }, songs: [{ id: 'old-server-song' }] });
    await load;

    expect(deps.setSongs).not.toHaveBeenCalled();
    expect(deps.setPlaylist).not.toHaveBeenCalled();
    expect(deps.setLoading).toHaveBeenCalledTimes(1);
    expect(deps.setLoading).toHaveBeenCalledWith(true);
  });

  it('does not repopulate membership after a concurrent invalidation', async () => {
    let resolveRequest!: (value: { playlist: { id: string }; songs: { id: string }[] }) => void;
    getPlaylistForServerMock.mockReturnValue(new Promise(resolve => { resolveRequest = resolve; }));
    filterMock.mockImplementation(async songs => songs);

    const load = runPlaylistLoad(makeDeps('shared'));
    usePlaylistMembershipStore.getState().invalidatePlaylistSongIds('shared', 'srv-1');
    resolveRequest({ playlist: { id: 'shared' }, songs: [{ id: 'stale-song' }] });
    await load;

    expect(usePlaylistMembershipStore.getState().getPlaylistSongIds('shared', 'srv-1')).toBeUndefined();
  });

  it('keeps the current UI mounted during a soft reload', async () => {
    getPlaylistForServerMock.mockResolvedValue({
      playlist: { id: 'pl-1' },
      songs: [{ id: 'a' }],
    });
    filterMock.mockResolvedValue([{ id: 'a' }]);
    const deps = { ...makeDeps('pl-1'), soft: true, resetForOwnerChange: vi.fn() };

    await runPlaylistLoad(deps);

    expect(deps.setLoading).not.toHaveBeenCalled();
    expect(deps.resetForOwnerChange).not.toHaveBeenCalled();
    expect(deps.setPlaylist).not.toHaveBeenCalledWith(null);
    expect(deps.setSongs).toHaveBeenCalledWith([{ id: 'a', serverId: 'srv-1' }]);
  });

  it('clears the previous owner state before loading a new owner', async () => {
    getPlaylistForServerMock.mockRejectedValue(new Error('unavailable'));
    const deps = { ...makeDeps('shared'), resetForOwnerChange: vi.fn() };

    await runPlaylistLoad(deps);

    expect(deps.setPlaylist).toHaveBeenCalledWith(null);
    expect(deps.setSongs).toHaveBeenCalledWith([]);
    expect(deps.setCustomCoverId).toHaveBeenCalledWith(null);
    expect(deps.setRatings).toHaveBeenCalledWith({});
    expect(deps.setStarredSongs).toHaveBeenCalledWith(new Set());
    expect(deps.resetForOwnerChange).toHaveBeenCalledOnce();
  });
});
