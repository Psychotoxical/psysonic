import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../store/authStore';
import { resolveAlbum, resolveAlbumForActiveServer } from './offlineMediaResolve';

const isOfflineBrowseActiveMock = vi.fn(() => false);
const offlineLocalBrowseEnabledMock = vi.fn((_serverId: string) => false);
const loadAlbumFromLocalPlaybackMock = vi.fn();
const loadAlbumFromLibraryIndexMock = vi.fn();
const shouldAttemptSubsonicForServerMock = vi.fn((_serverId: string, _trackId?: string) => true);
const getAlbumForServerMock = vi.fn((_serverId: string, _albumId: string) => ({}));

vi.mock('./offlineBrowseMode', () => ({
  isOfflineBrowseActive: () => isOfflineBrowseActiveMock(),
}));

vi.mock('./offlineLocalBrowse', () => ({
  offlineLocalBrowseEnabled: (id: string) => offlineLocalBrowseEnabledMock(id),
  loadAlbumFromLocalPlayback: (serverId: string, albumId: string) =>
    loadAlbumFromLocalPlaybackMock(serverId, albumId),
}));

vi.mock('./offlineLibraryIndexLoad', () => ({
  loadAlbumFromLibraryIndex: (...args: unknown[]) => loadAlbumFromLibraryIndexMock(...args),
}));

vi.mock('../network/subsonicNetworkGuard', () => ({
  shouldAttemptSubsonicForServer: (serverId: string, trackId?: string) =>
    shouldAttemptSubsonicForServerMock(serverId, trackId),
}));

vi.mock('../../api/subsonicLibrary', () => ({
  getAlbumForServer: (serverId: string, albumId: string) => getAlbumForServerMock(serverId, albumId),
}));

describe('offlineMediaResolve', () => {
  beforeEach(() => {
    isOfflineBrowseActiveMock.mockReturnValue(false);
    offlineLocalBrowseEnabledMock.mockReturnValue(false);
    shouldAttemptSubsonicForServerMock.mockReturnValue(true);
    loadAlbumFromLocalPlaybackMock.mockReset();
    loadAlbumFromLibraryIndexMock.mockReset();
    getAlbumForServerMock.mockReset();
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

  it('resolveAlbumForActiveServer uses active server id', async () => {
    getAlbumForServerMock.mockResolvedValue({
      album: { id: 'alb-2' },
      songs: [],
    });
    await resolveAlbumForActiveServer('alb-2');
    expect(getAlbumForServerMock).toHaveBeenCalledWith('srv-1', 'alb-2');
  });
});
