import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAYLIST_SONG_ID_GET_BATCH,
  addSongsToPlaylist,
  chunkIndicesForSubsonicGet,
  chunkRemovalIndicesForSubsonicGet,
  chunkSongIdsForSubsonicGet,
  applyNativePlaylistSmartMetadata,
  getPlaylistsForServer,
  getPlaylistsForServers,
  getPlaylistsForServersSettled,
  getPlaylistForServer,
  removePlaylistSongsAtIndices,
  updatePlaylist,
} from '@/lib/api/subsonicPlaylists';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';

const { apiMock, apiForServerMock, ndListPlaylistsMock } = vi.hoisted(() => {
  const fn = vi.fn();
  return { apiMock: fn, apiForServerMock: vi.fn(), ndListPlaylistsMock: vi.fn() };
});

vi.mock('@/lib/api/subsonicClient', () => ({
  api: apiMock,
  apiForServer: apiForServerMock,
}));

vi.mock('@/features/offline', () => ({
  schedulePinnedPlaylistSync: vi.fn(),
}));

vi.mock('@/lib/api/navidromeSmart', () => ({
  ndListPlaylists: ndListPlaylistsMock,
}));

vi.mock('@/lib/network/subsonicNetworkGuard', () => ({
  shouldAttemptSubsonicForServer: () => true,
}));

describe('subsonicPlaylists batching', () => {
  beforeEach(() => {
    resetAuthStore();
    apiMock.mockReset();
    apiForServerMock.mockReset();
    ndListPlaylistsMock.mockReset();
    apiMock.mockImplementation(async (endpoint: string) => {
      if (endpoint === 'getPlaylist.view') {
        return {
          playlist: {
            id: 'pl1',
            entry: Array.from({ length: 400 }, (_, i) => ({ id: `existing-${i}` })),
          },
        };
      }
      return {};
    });
  });

  it('aggregates playlists in server order and tolerates partial failure', async () => {
    apiForServerMock.mockImplementation(async (serverId: string) => {
      if (serverId === 'b') throw new Error('offline');
      return { playlists: { playlist: [{ id: `shared`, name: serverId }] } };
    });

    await expect(getPlaylistsForServers(['a', 'b', 'c', 'a'])).resolves.toEqual([
      expect.objectContaining({ id: 'shared', name: 'a', serverId: 'a' }),
      expect.objectContaining({ id: 'shared', name: 'c', serverId: 'c' }),
    ]);
    expect(apiForServerMock.mock.calls.map(call => call[0])).toEqual(['a', 'b', 'c']);
  });

  it('reports failed owners separately from successful playlists', async () => {
    apiForServerMock.mockImplementation(async (serverId: string) => {
      if (serverId === 'b') throw new Error('offline');
      return { playlists: { playlist: [{ id: `pl-${serverId}`, name: serverId }] } };
    });

    await expect(getPlaylistsForServersSettled(['a', 'b'])).resolves.toEqual({
      playlists: [{ id: 'pl-a', name: 'a', serverId: 'a' }],
      failedServerIds: ['b'],
    });
  });

  it('joins native metadata by id and writes authoritative booleans', async () => {
    const playlists = [
      { id: 'native-smart', name: 'No prefix', songCount: 0, duration: 0, created: '', changed: '' },
      { id: 'prefixed-regular', name: 'psy-smart-Regular', songCount: 0, duration: 0, created: '', changed: '' },
      { id: 'missing', name: 'psy-smart-Missing', songCount: 0, duration: 0, created: '', changed: '' },
    ];

    expect(applyNativePlaylistSmartMetadata(playlists, [
      { id: 'native-smart', rules: { all: [] } },
      { id: 'prefixed-regular', rules: undefined },
    ])).toEqual([
      expect.objectContaining({ id: 'native-smart', smart: true }),
      expect.objectContaining({ id: 'prefixed-regular', smart: false }),
      expect.objectContaining({ id: 'missing', smart: false }),
    ]);
  });

  it('loads unfiltered native metadata for each Navidrome owner', async () => {
    useAuthStore.setState({
      servers: [
        { id: 'a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
        { id: 'b', name: 'B', url: 'https://b.test', username: 'u', password: 'p' },
      ],
      subsonicServerIdentityByServer: {
        a: { type: 'navidrome' },
        b: { type: 'navidrome' },
      },
    });
    apiForServerMock.mockImplementation(async (serverId: string) => ({
      playlists: { playlist: [{ id: 'shared', name: `From ${serverId}` }] },
    }));
    ndListPlaylistsMock.mockImplementation(async (serverId: string) => [
      { id: 'shared', rules: serverId === 'a' ? { any: [] } : undefined },
    ]);

    await expect(getPlaylistsForServers(['a', 'b'])).resolves.toEqual([
      expect.objectContaining({ id: 'shared', serverId: 'a', smart: true }),
      expect.objectContaining({ id: 'shared', serverId: 'b', smart: false }),
    ]);
    expect(ndListPlaylistsMock.mock.calls.map(call => call[0])).toEqual(['a', 'b']);
  });

  it('leaves classification unknown when native metadata fails', async () => {
    useAuthStore.setState({
      servers: [{ id: 'a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' }],
      subsonicServerIdentityByServer: { a: { type: 'navidrome' } },
    });
    apiForServerMock.mockResolvedValue({
      playlists: { playlist: [{ id: 'legacy', name: 'psy-smart-Legacy' }] },
    });
    ndListPlaylistsMock.mockRejectedValue(new Error('native API unavailable'));

    const playlists = await getPlaylistsForServer('a');

    expect(playlists[0]).toEqual(expect.objectContaining({
      id: 'legacy',
      serverId: 'a',
    }));
    expect(playlists[0]).not.toHaveProperty('smart');
  });

  it('stamps playlist details and songs with their owner server', async () => {
    apiForServerMock.mockResolvedValue({
      playlist: { id: 'shared', name: 'Remote', entry: [{ id: 'song-1' }] },
    });

    await expect(getPlaylistForServer('server-b', 'shared')).resolves.toEqual({
      playlist: expect.objectContaining({ id: 'shared', serverId: 'server-b' }),
      songs: [{ id: 'song-1', serverId: 'server-b' }],
    });
  });

  it('routes mutations through the explicit owner server', async () => {
    await addSongsToPlaylist('shared', ['song-1'], 'server-b');

    expect(apiMock).not.toHaveBeenCalled();
    expect(apiForServerMock).toHaveBeenCalledWith('server-b', 'updatePlaylist.view', {
      playlistId: 'shared',
      songIdToAdd: ['song-1'],
    });
  });

  it('chunks song ids for GET batching', () => {
    const ids = Array.from({ length: 320 }, (_, i) => `track-${i}`);
    const batches = chunkSongIdsForSubsonicGet(ids, 150);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(150);
    expect(batches[2]).toHaveLength(20);
  });

  it('chunks clear indices from the end', () => {
    const batches = chunkIndicesForSubsonicGet(340, 150);
    expect(batches).toHaveLength(3);
    expect(batches[0][0]).toBe(190);
    expect(batches[0][batches[0].length - 1]).toBe(339);
    expect(batches[2]).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it('addSongsToPlaylist uses updatePlaylist.view with songIdToAdd only', async () => {
    const ids = Array.from({ length: PLAYLIST_SONG_ID_GET_BATCH + 5 }, (_, i) => `s${i}`);
    await addSongsToPlaylist('pl1', ids);
    expect(apiMock).toHaveBeenCalledTimes(2);
    const calls = apiMock.mock.calls as Array<[string, Record<string, unknown>?]>;
    expect(calls[0]?.[0]).toBe('updatePlaylist.view');
    expect(calls[0]?.[1]).toEqual({
      playlistId: 'pl1',
      songIdToAdd: ids.slice(0, PLAYLIST_SONG_ID_GET_BATCH),
    });
    expect(calls[1]?.[1]).toEqual({
      playlistId: 'pl1',
      songIdToAdd: ids.slice(PLAYLIST_SONG_ID_GET_BATCH),
    });
  });

  it('chunks removal indices high-to-low', () => {
    const indices = Array.from({ length: 200 }, (_, i) => i);
    const batches = chunkRemovalIndicesForSubsonicGet(indices, 150);
    expect(batches).toHaveLength(2);
    expect(batches[0][0]).toBe(199);
    expect(batches[0][batches[0].length - 1]).toBe(50);
    expect(batches[1][0]).toBe(49);
    expect(batches[1][batches[1].length - 1]).toBe(0);
  });

  it('removePlaylistSongsAtIndices removes high indices first', async () => {
    const indices = Array.from({ length: 200 }, (_, i) => i);
    await removePlaylistSongsAtIndices('pl1', indices);
    expect(apiMock).toHaveBeenCalledTimes(2);
    const calls = apiMock.mock.calls as Array<[string, Record<string, unknown>?]>;
    const firstBatch = calls[0]?.[1]?.songIndexToRemove as number[];
    expect(firstBatch[0]).toBe(199);
    expect(firstBatch[firstBatch.length - 1]).toBe(50);
  });

  it('updatePlaylist clears then appends when replacing a large list', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `s${i}`);
    await updatePlaylist('pl1', ids, 400);
    const calls = apiMock.mock.calls as Array<[string, Record<string, unknown>?]>;
    const endpoints = calls.map(call => call[0]);
    expect(endpoints.filter(e => e === 'updatePlaylist.view').length).toBeGreaterThan(0);
    expect(endpoints.filter(e => e === 'createPlaylist.view')).toHaveLength(0);
    expect(calls.some(call => call[1]?.songIdToAdd)).toBe(true);
  });
});
