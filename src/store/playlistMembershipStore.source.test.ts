import { beforeEach, describe, expect, it } from 'vitest';
import { usePlaylistMembershipStore } from './playlistMembershipStore';

describe('playlistMembershipStore source identity', () => {
  beforeEach(() => usePlaylistMembershipStore.setState({ songIdsByCacheKey: {} }));

  it('does not collide when two servers use the same playlist id', () => {
    const store = usePlaylistMembershipStore.getState();
    store.setPlaylistSongIds('same', ['a'], 'server-a');
    store.setPlaylistSongIds('same', ['b'], 'server-b');
    expect(store.getPlaylistSongIds('same', 'server-a')).toEqual(['a']);
    expect(store.getPlaylistSongIds('same', 'server-b')).toEqual(['b']);
  });
});
