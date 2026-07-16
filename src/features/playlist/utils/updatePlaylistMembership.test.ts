import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reconcilePlaylistMembership,
  updatePlaylistMembership,
} from '@/features/playlist/utils/updatePlaylistMembership';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';
import { makeSubsonicSong } from '@/test/helpers/factories';

const getPlaylistForServerMock = vi.fn();
const updatePlaylistForServerMock = vi.fn();

vi.mock('@/lib/api/subsonicPlaylists', () => ({
  getPlaylistForServer: (...args: unknown[]) => getPlaylistForServerMock(...args),
  updatePlaylistForServer: (...args: unknown[]) => updatePlaylistForServerMock(...args),
}));

const songs = (...ids: string[]) => ids.map(id => makeSubsonicSong({ id, title: id }));

describe('playlist membership updates', () => {
  beforeEach(() => {
    getPlaylistForServerMock.mockReset();
    updatePlaylistForServerMock.mockReset().mockResolvedValue(undefined);
    usePlaylistMembershipStore.setState({ songIdsByCacheKey: {} });
  });

  it('preserves hidden members when removing a visible track', async () => {
    usePlaylistMembershipStore.getState().setPlaylistSongIds(
      'pl-1',
      ['visible-a', 'hidden-a', 'visible-b', 'hidden-b', 'visible-c'],
      'srv-owner',
    );

    await updatePlaylistMembership({
      playlistId: 'pl-1',
      ownerServerId: 'srv-owner',
      previousVisibleSongs: songs('visible-a', 'visible-b', 'visible-c'),
      nextVisibleSongs: songs('visible-a', 'visible-c'),
    });

    const expected = ['visible-a', 'hidden-a', 'hidden-b', 'visible-c'];
    expect(updatePlaylistForServerMock).toHaveBeenCalledWith('srv-owner', 'pl-1', expected, 5);
    expect(usePlaylistMembershipStore.getState().getPlaylistSongIds('pl-1', 'srv-owner')).toEqual(expected);
  });

  it('reorders visible tracks in their full-membership slots around hidden entries', () => {
    expect(reconcilePlaylistMembership(
      ['visible-a', 'hidden-a', 'visible-b', 'hidden-b', 'visible-c'],
      ['visible-a', 'visible-b', 'visible-c'],
      ['visible-c', 'visible-a', 'visible-b'],
    )).toEqual(['visible-c', 'hidden-a', 'visible-a', 'hidden-b', 'visible-b']);
  });

  it('appends added visible tracks without replacing hidden members', async () => {
    usePlaylistMembershipStore.getState().setPlaylistSongIds(
      'pl-1',
      ['visible-a', 'hidden-a', 'visible-b'],
      'srv-owner',
    );

    await updatePlaylistMembership({
      playlistId: 'pl-1',
      ownerServerId: 'srv-owner',
      previousVisibleSongs: songs('visible-a', 'visible-b'),
      nextVisibleSongs: songs('visible-a', 'visible-b', 'added-a', 'added-b'),
    });

    expect(updatePlaylistForServerMock).toHaveBeenCalledWith(
      'srv-owner',
      'pl-1',
      ['visible-a', 'hidden-a', 'visible-b', 'added-a', 'added-b'],
      3,
    );
  });

  it('loads full owner-server membership when the cache was invalidated', async () => {
    getPlaylistForServerMock.mockResolvedValue({
      playlist: { id: 'pl-1' },
      songs: songs('visible-a', 'hidden-a'),
    });

    await updatePlaylistMembership({
      playlistId: 'pl-1',
      ownerServerId: 'srv-owner',
      previousVisibleSongs: songs('visible-a'),
      nextVisibleSongs: songs('visible-a', 'added-a'),
    });

    expect(getPlaylistForServerMock).toHaveBeenCalledWith('srv-owner', 'pl-1');
    expect(updatePlaylistForServerMock).toHaveBeenCalledWith(
      'srv-owner',
      'pl-1',
      ['visible-a', 'hidden-a', 'added-a'],
      2,
    );
  });

  it('does not drop retained visible tracks when cached membership is stale', () => {
    expect(reconcilePlaylistMembership(
      ['visible-a', 'hidden-a'],
      ['visible-a', 'visible-b'],
      ['visible-b', 'visible-a'],
    )).toEqual(['visible-b', 'hidden-a', 'visible-a']);
  });
});
