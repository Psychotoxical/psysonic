import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlaylistsLibraryScopeCounts } from '@/features/playlist/hooks/usePlaylistsLibraryScopeCounts';
import type { SubsonicPlaylist, SubsonicSong } from '@/lib/api/subsonicTypes';

const { getPlaylistForServer, filterSongsToServerLibrary } = vi.hoisted(() => ({
  getPlaylistForServer: vi.fn(),
  filterSongsToServerLibrary: vi.fn(async (songs: SubsonicSong[], serverId: string) =>
    songs.filter(song => song.serverId === serverId),
  ),
}));

vi.mock('@/lib/api/subsonicPlaylists', () => ({ getPlaylistForServer }));
vi.mock('@/lib/api/subsonicLibrary', () => ({ filterSongsToServerLibrary }));
vi.mock('@/features/offline', () => ({ useOfflineBrowseContext: () => ({ active: false }) }));

const playlist = (serverId: string): SubsonicPlaylist => ({
  id: 'same', serverId, name: serverId, songCount: 99, duration: 99, created: '', changed: '',
});

describe('usePlaylistsLibraryScopeCounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlaylistForServer.mockImplementation(async (serverId: string) => ({
      playlist: playlist(serverId),
      songs: serverId === 's1'
        ? [{ id: 'a', title: 'A', duration: 10, serverId: 's1' }]
        : [
            { id: 'b', title: 'B', duration: 20, serverId: 's2' },
            { id: 'c', title: 'C', duration: 30, serverId: 's2' },
          ],
    }));
  });

  it('keeps equal playlist ids with different counts and durations separate', async () => {
    const playlists = [playlist('s1'), playlist('s2')];
    const { result } = renderHook(() => usePlaylistsLibraryScopeCounts(playlists, 1));

    await waitFor(() => expect(Object.keys(result.current.filteredSongCountByPlaylist)).toHaveLength(2));
    expect(result.current.filteredSongCountByPlaylist).toEqual({ 's1:same': 1, 's2:same': 2 });
    expect(result.current.filteredDurationByPlaylist).toEqual({ 's1:same': 10, 's2:same': 50 });
  });
});
