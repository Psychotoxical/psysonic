import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAYLIST_SONG_ID_GET_BATCH,
  addSongsToPlaylist,
  chunkIndicesForSubsonicGet,
  chunkRemovalIndicesForSubsonicGet,
  chunkSongIdsForSubsonicGet,
  removePlaylistSongsAtIndices,
  updatePlaylist,
  updatePlaylistForServer,
  updatePlaylistMetaForServer,
  deletePlaylistForServer,
} from '@/lib/api/subsonicPlaylists';

const { apiMock, apiForServerMock } = vi.hoisted(() => {
  const fn = vi.fn();
  return { apiMock: fn, apiForServerMock: vi.fn() };
});

vi.mock('@/lib/api/subsonicClient', () => ({
  api: apiMock,
  apiForServer: apiForServerMock,
}));

vi.mock('@/features/offline', () => ({
  schedulePinnedPlaylistSync: vi.fn(),
}));

describe('subsonicPlaylists batching', () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiForServerMock.mockReset();
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

  it('routes detail mutations to the explicit playlist owner', async () => {
    await updatePlaylistForServer('srv-b', 'same-id', ['b-1', 'b-2'], 1);
    await updatePlaylistMetaForServer('srv-b', 'same-id', 'B playlist', 'comment', true);
    await deletePlaylistForServer('srv-b', 'same-id');

    expect(apiForServerMock).toHaveBeenNthCalledWith(1, 'srv-b', 'createPlaylist.view', {
      playlistId: 'same-id',
      songId: ['b-1', 'b-2'],
    });
    expect(apiForServerMock).toHaveBeenNthCalledWith(2, 'srv-b', 'updatePlaylist.view', {
      playlistId: 'same-id',
      name: 'B playlist',
      comment: 'comment',
      public: true,
    });
    expect(apiForServerMock).toHaveBeenNthCalledWith(3, 'srv-b', 'deletePlaylist.view', { id: 'same-id' });
    expect(apiMock).not.toHaveBeenCalled();
  });
});
