import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addTracksToPlaylistWithDedup } from '@/features/playlist/utils/addTracksToPlaylistWithDedup';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';

const addSongsToPlaylistMock = vi.fn(async (_id: string, _ids: string[]) => {});
const getPlaylistMock = vi.fn(async (_id: string) => ({ playlist: { id: 'pl-1' }, songs: [{ id: 'a' }, { id: 'b' }] }));
const confirmMock = vi.fn(async () => false);

vi.mock('@/lib/api/subsonicPlaylists', () => ({
  addSongsToPlaylist: (id: string, ids: string[]) => addSongsToPlaylistMock(id, ids),
  getPlaylist: (id: string) => getPlaylistMock(id),
}));

vi.mock('@/store/confirmModalStore', () => ({
  useConfirmModalStore: {
    getState: () => ({ request: () => confirmMock() }),
  },
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: {
    getState: () => ({ activeServerId: 'srv-1' }),
  },
}));

describe('addTracksToPlaylistWithDedup', () => {
  beforeEach(() => {
    addSongsToPlaylistMock.mockClear();
    getPlaylistMock.mockClear();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(false);
    usePlaylistMembershipStore.setState({
      songIdsByCacheKey: { 'srv-1:pl-1': ['a', 'b'] },
    });
  });

  it('dedupes against cached ids without getPlaylist', async () => {
    const result = await addTracksToPlaylistWithDedup('pl-1', 'Mix', ['b', 'c'], k => k);
    expect(result).toMatchObject({ outcome: 'partial', addedCount: 1, skippedCount: 1 });
    expect(getPlaylistMock).not.toHaveBeenCalled();
    expect(addSongsToPlaylistMock).toHaveBeenCalledWith('pl-1', ['c']);
    expect(usePlaylistMembershipStore.getState().getPlaylistSongIds('pl-1')).toEqual(['a', 'b', 'c']);
  });

  it('fetches membership once on cold cache and dedupes', async () => {
    usePlaylistMembershipStore.setState({ songIdsByCacheKey: {} });
    getPlaylistMock.mockResolvedValue({
      playlist: { id: 'pl-2' },
      songs: [{ id: 'x' }],
    });
    const result = await addTracksToPlaylistWithDedup('pl-2', 'Cold', ['x', 'y'], k => k);
    expect(result).toMatchObject({ outcome: 'partial', addedCount: 1, skippedCount: 1 });
    expect(getPlaylistMock).toHaveBeenCalledTimes(1);
    expect(addSongsToPlaylistMock).toHaveBeenCalledWith('pl-2', ['y']);
    expect(usePlaylistMembershipStore.getState().getPlaylistSongIds('pl-2')).toEqual(['x', 'y']);
  });

  it('invalidates cache when the write fails', async () => {
    addSongsToPlaylistMock.mockRejectedValueOnce(new Error('boom'));
    await expect(
      addTracksToPlaylistWithDedup('pl-1', 'Mix', ['c'], k => k),
    ).rejects.toThrow('boom');
    expect(usePlaylistMembershipStore.getState().getPlaylistSongIds('pl-1')).toBeUndefined();
  });
});
