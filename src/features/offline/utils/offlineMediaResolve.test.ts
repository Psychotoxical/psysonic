import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import {
  resolveAlbum,
  resolveAlbumForActiveServer,
  resolveArtist,
  resolvePlaylist,
} from '@/features/offline/utils/offlineMediaResolve';

const isOfflineBrowseActiveMock = vi.fn(() => false);
const offlineLocalBrowseEnabledMock = vi.fn((_serverId: string) => false);
const playlistsOfflineBrowseEnabledMock = vi.fn((_serverId: string) => false);
const loadAlbumFromLocalPlaybackMock = vi.fn();
const loadArtistFromLocalPlaybackMock = vi.fn();
const loadAlbumFromLibraryIndexMock = vi.fn();
const loadArtistFromLibraryIndexMock = vi.fn();
const loadOfflineBrowsablePlaylistMock = vi.fn();
const shouldAttemptSubsonicForServerMock = vi.fn((_serverId: string, _trackId?: string) => true);
const getAlbumForServerMock = vi.fn((_serverId: string, _albumId: string) => ({}));
const getArtistForServerMock = vi.fn((_serverId: string, _artistId: string) => ({}));
const getPlaylistForServerMock = vi.fn((_serverId: string, _playlistId: string) => ({}));
const libraryIsReadyMock = vi.fn(async (_serverId: string) => false);

vi.mock('@/features/offline/utils/offlineBrowseMode', () => ({
  isOfflineBrowseActive: () => isOfflineBrowseActiveMock(),
}));

vi.mock('@/features/offline/utils/offlineLocalBrowse', () => ({
  offlineLocalBrowseEnabled: (id: string) => offlineLocalBrowseEnabledMock(id),
  loadAlbumFromLocalPlayback: (serverId: string, albumId: string) =>
    loadAlbumFromLocalPlaybackMock(serverId, albumId),
  loadArtistFromLocalPlayback: (serverId: string, artistId: string) =>
    loadArtistFromLocalPlaybackMock(serverId, artistId),
}));

vi.mock('@/features/offline/utils/offlineLibraryIndexLoad', () => ({
  loadAlbumFromLibraryIndex: (...args: unknown[]) => loadAlbumFromLibraryIndexMock(...args),
  loadArtistFromLibraryIndex: (...args: unknown[]) => loadArtistFromLibraryIndexMock(...args),
}));

vi.mock('@/features/offline/utils/offlinePlaylistBrowse', () => ({
  playlistsOfflineBrowseEnabled: (id: string) => playlistsOfflineBrowseEnabledMock(id),
  loadOfflineBrowsablePlaylist: (playlistId: string, serverId: string) =>
    loadOfflineBrowsablePlaylistMock(playlistId, serverId),
}));

vi.mock('@/lib/network/subsonicNetworkGuard', () => ({
  shouldAttemptSubsonicForServer: (serverId: string, trackId?: string) =>
    shouldAttemptSubsonicForServerMock(serverId, trackId),
}));

vi.mock('@/lib/api/subsonicLibrary', () => ({
  getAlbumForServer: (serverId: string, albumId: string) => getAlbumForServerMock(serverId, albumId),
}));

vi.mock('@/lib/api/subsonicArtists', () => ({
  getArtistForServer: (serverId: string, artistId: string) => getArtistForServerMock(serverId, artistId),
}));

vi.mock('@/lib/api/subsonicPlaylists', () => ({
  getPlaylistForServer: (serverId: string, playlistId: string) =>
    getPlaylistForServerMock(serverId, playlistId),
}));

vi.mock('@/lib/library/libraryReady', () => ({
  libraryIsReady: (serverId: string) => libraryIsReadyMock(serverId),
}));

describe('offlineMediaResolve', () => {
  beforeEach(() => {
    isOfflineBrowseActiveMock.mockReturnValue(false);
    offlineLocalBrowseEnabledMock.mockReturnValue(false);
    playlistsOfflineBrowseEnabledMock.mockReturnValue(false);
    shouldAttemptSubsonicForServerMock.mockReturnValue(true);
    libraryIsReadyMock.mockReset();
    libraryIsReadyMock.mockResolvedValue(false);
    loadAlbumFromLocalPlaybackMock.mockReset();
    loadArtistFromLocalPlaybackMock.mockReset();
    loadAlbumFromLibraryIndexMock.mockReset();
    loadArtistFromLibraryIndexMock.mockReset();
    loadOfflineBrowsablePlaylistMock.mockReset();
    getAlbumForServerMock.mockReset();
    getArtistForServerMock.mockReset();
    getPlaylistForServerMock.mockReset();
    useAuthStore.setState({ favoritesOfflineEnabled: true, activeServerId: 'srv-1' } as Partial<
      ReturnType<typeof useAuthStore.getState>
    >);
  });

  it('resolveAlbum prefers local bytes when offline browse and local library enabled', async () => {
    isOfflineBrowseActiveMock.mockReturnValue(true);
    offlineLocalBrowseEnabledMock.mockReturnValue(true);
    loadAlbumFromLocalPlaybackMock.mockResolvedValue({
      album: { id: 'alb-1', name: 'Local' },
      songs: [{ id: 't1', title: 'One' }],
    });
    const result = await resolveAlbum('srv-1', 'alb-1');
    expect(loadAlbumFromLocalPlaybackMock).toHaveBeenCalledWith('srv-1', 'alb-1');
    expect(result?.songs).toHaveLength(1);
    expect(getAlbumForServerMock).not.toHaveBeenCalled();
  });

  it('resolveAlbum uses network when allowed', async () => {
    getAlbumForServerMock.mockResolvedValue({
      album: { id: 'alb-1', name: 'Net' },
      songs: [{ id: 't1' }, { id: 't2' }],
    });
    const result = await resolveAlbum('srv-1', 'alb-1');
    expect(getAlbumForServerMock).toHaveBeenCalledWith('srv-1', 'alb-1');
    expect(result?.songs).toHaveLength(2);
  });

  it('resolveAlbum falls back to library index when network blocked', async () => {
    shouldAttemptSubsonicForServerMock.mockReturnValue(false);
    loadAlbumFromLibraryIndexMock.mockResolvedValue({
      album: { id: 'alb-1', name: 'Idx' },
      songs: [{ id: 't1' }],
    });
    const result = await resolveAlbum('srv-1', 'alb-1');
    expect(loadAlbumFromLibraryIndexMock).toHaveBeenCalledWith('srv-1', 'alb-1');
    expect(result?.album.name).toBe('Idx');
  });

  it('resolveAlbum prefers the library index when ready, without hitting the network', async () => {
    libraryIsReadyMock.mockResolvedValue(true);
    loadAlbumFromLibraryIndexMock.mockResolvedValue({
      album: { id: 'alb-1', name: 'Idx' },
      songs: [{ id: 't1' }],
    });
    const result = await resolveAlbum('srv-1', 'alb-1');
    expect(loadAlbumFromLibraryIndexMock).toHaveBeenCalledWith('srv-1', 'alb-1');
    expect(result?.album.name).toBe('Idx');
    expect(getAlbumForServerMock).not.toHaveBeenCalled();
  });

  it('resolveAlbum falls back to network when the index is ready but has no hit', async () => {
    libraryIsReadyMock.mockResolvedValue(true);
    loadAlbumFromLibraryIndexMock.mockResolvedValue(null);
    getAlbumForServerMock.mockResolvedValue({
      album: { id: 'alb-1', name: 'Net' },
      songs: [{ id: 't1' }, { id: 't2' }],
    });
    const result = await resolveAlbum('srv-1', 'alb-1');
    expect(loadAlbumFromLibraryIndexMock).toHaveBeenCalledWith('srv-1', 'alb-1');
    expect(getAlbumForServerMock).toHaveBeenCalledWith('srv-1', 'alb-1');
    expect(result?.album.name).toBe('Net');
  });

  it('resolveAlbumForActiveServer uses active server id', async () => {
    getAlbumForServerMock.mockResolvedValue({
      album: { id: 'alb-2' },
      songs: [],
    });
    await resolveAlbumForActiveServer('alb-2');
    expect(getAlbumForServerMock).toHaveBeenCalledWith('srv-1', 'alb-2');
  });

  it('resolveArtist prefers local bytes when offline browse and local library enabled', async () => {
    isOfflineBrowseActiveMock.mockReturnValue(true);
    offlineLocalBrowseEnabledMock.mockReturnValue(true);
    loadArtistFromLocalPlaybackMock.mockResolvedValue({
      artist: { id: 'art-1', name: 'Local Artist' },
      albums: [{ id: 'alb-1' }],
    });
    const result = await resolveArtist('srv-1', 'art-1');
    expect(loadArtistFromLocalPlaybackMock).toHaveBeenCalledWith('srv-1', 'art-1');
    expect(result?.albums).toHaveLength(1);
    expect(getArtistForServerMock).not.toHaveBeenCalled();
  });

  it('resolvePlaylist uses offline browse cache when enabled', async () => {
    isOfflineBrowseActiveMock.mockReturnValue(true);
    playlistsOfflineBrowseEnabledMock.mockReturnValue(true);
    loadOfflineBrowsablePlaylistMock.mockResolvedValue({
      playlist: { id: 'pl-1', name: 'Offline' },
      songs: [{ id: 't1' }],
    });
    const result = await resolvePlaylist('srv-1', 'pl-1');
    expect(loadOfflineBrowsablePlaylistMock).toHaveBeenCalledWith('pl-1', 'srv-1');
    expect(result?.songs).toHaveLength(1);
    expect(getPlaylistForServerMock).not.toHaveBeenCalled();
  });

  it('resolvePlaylist uses network when allowed', async () => {
    getPlaylistForServerMock.mockResolvedValue({
      playlist: { id: 'pl-2', name: 'Net' },
      songs: [{ id: 't1' }, { id: 't2' }],
    });
    const result = await resolvePlaylist('srv-1', 'pl-2');
    expect(getPlaylistForServerMock).toHaveBeenCalledWith('srv-1', 'pl-2');
    expect(result?.songs).toHaveLength(2);
  });
});
