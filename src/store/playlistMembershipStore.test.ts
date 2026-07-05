import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';

vi.mock('@/store/authStore', () => ({
  useAuthStore: {
    getState: () => ({ activeServerId: 'srv-1' }),
  },
}));

describe('playlistMembershipStore', () => {
  beforeEach(() => {
    usePlaylistMembershipStore.setState({ songIdsByCacheKey: {} });
  });

  it('stores and reads ids scoped to active server', () => {
    usePlaylistMembershipStore.getState().setPlaylistSongIds('pl-1', ['a', 'b']);
    expect(usePlaylistMembershipStore.getState().getPlaylistSongIds('pl-1')).toEqual(['a', 'b']);
  });

  it('appends and removes by index', () => {
    const store = usePlaylistMembershipStore.getState();
    store.setPlaylistSongIds('pl-1', ['a', 'b', 'c']);
    store.appendPlaylistSongIds('pl-1', ['d']);
    store.removePlaylistSongIdsAtIndices('pl-1', [1]);
    expect(usePlaylistMembershipStore.getState().getPlaylistSongIds('pl-1')).toEqual(['a', 'c', 'd']);
  });

  it('invalidate drops a single playlist; clearAll drops everything', () => {
    const store = usePlaylistMembershipStore.getState();
    store.setPlaylistSongIds('pl-1', ['a']);
    store.setPlaylistSongIds('pl-2', ['b']);
    store.invalidatePlaylistSongIds('pl-1');
    expect(usePlaylistMembershipStore.getState().getPlaylistSongIds('pl-1')).toBeUndefined();
    expect(usePlaylistMembershipStore.getState().getPlaylistSongIds('pl-2')).toEqual(['b']);
    store.clearAllPlaylistSongIds();
    expect(usePlaylistMembershipStore.getState().getPlaylistSongIds('pl-2')).toBeUndefined();
  });
});
