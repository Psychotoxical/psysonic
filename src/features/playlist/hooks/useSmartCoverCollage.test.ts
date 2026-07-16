import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSmartCoverCollage } from '@/features/playlist/hooks/useSmartCoverCollage';
import type { SubsonicPlaylist, SubsonicSong } from '@/lib/api/subsonicTypes';

const { getPlaylistForServer, filterSongsToServerLibrary } = vi.hoisted(() => ({
  getPlaylistForServer: vi.fn(),
  filterSongsToServerLibrary: vi.fn(async (songs: SubsonicSong[]) => songs),
}));

vi.mock('@/lib/api/subsonicPlaylists', () => ({ getPlaylistForServer }));
vi.mock('@/lib/api/subsonicLibrary', () => ({ filterSongsToServerLibrary }));

const playlist = (serverId: string): SubsonicPlaylist => ({
  id: 'same', serverId, name: 'psy-smart-mix', songCount: 1, duration: 1, created: '', changed: '',
});

describe('useSmartCoverCollage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlaylistForServer.mockImplementation(async (serverId: string) => ({
      playlist: playlist(serverId),
      songs: [{ id: `song-${serverId}`, title: serverId, coverArt: `cover-${serverId}`, serverId }],
    }));
  });

  it('keeps equal playlist ids and their covers server-qualified', async () => {
    const playlists = [playlist('s1'), playlist('s2')];
    const { result } = renderHook(() => useSmartCoverCollage(playlists, 1));

    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2));
    expect(result.current).toEqual({ 's1:same': ['cover-s1'], 's2:same': ['cover-s2'] });
    expect(getPlaylistForServer).toHaveBeenCalledWith('s1', 'same');
    expect(getPlaylistForServer).toHaveBeenCalledWith('s2', 'same');
    expect(filterSongsToServerLibrary).toHaveBeenCalledWith(expect.any(Array), 's1');
    expect(filterSongsToServerLibrary).toHaveBeenCalledWith(expect.any(Array), 's2');
  });
});
