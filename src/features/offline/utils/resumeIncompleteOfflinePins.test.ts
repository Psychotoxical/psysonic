import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useOfflineStore } from '@/features/offline/store/offlineStore';
import { resumeIncompleteOfflinePins } from '@/features/offline/utils/resumeIncompleteOfflinePins';

const isActiveServerReachableMock = vi.fn(() => true);
const isOfflinePinCompleteMock = vi.fn((_albumId: string, _serverId: string) => false);
const resolveAlbumForServerMock = vi.fn();
const downloadAlbumMock = vi.fn();

vi.mock('@/lib/network/activeServerReachability', () => ({
  isActiveServerReachable: () => isActiveServerReachableMock(),
  onActiveServerBecameReachable: () => () => {},
}));

vi.mock('@/features/offline/utils/offlineLibraryHelpers', () => ({
  isOfflinePinComplete: (albumId: string, serverId: string) =>
    isOfflinePinCompleteMock(albumId, serverId),
}));

vi.mock('@/features/offline/utils/offlineMediaResolve', () => ({
  resolveAlbumForServer: (serverId: string, albumId: string) =>
    resolveAlbumForServerMock(serverId, albumId),
}));

vi.mock('@/lib/api/library', () => ({
  libraryGetTracksBatchChunked: vi.fn(async () => []),
  LIBRARY_TRACKS_BATCH_LIMIT: 100,
}));

describe('resumeIncompleteOfflinePins', () => {
  beforeEach(() => {
    isActiveServerReachableMock.mockReturnValue(true);
    isOfflinePinCompleteMock.mockReturnValue(false);
    resolveAlbumForServerMock.mockReset();
    downloadAlbumMock.mockReset();
    useAuthStore.setState({
      activeServerId: 'srv-1',
      servers: [{ id: 'srv-1', name: 'A', url: 'https://a.test', username: 'u', password: 'p' }],
    });
    useOfflineStore.setState({
      albums: {
        'srv-1:alb-1': {
          id: 'alb-1',
          serverId: 'srv-1',
          name: 'Album',
          artist: 'Artist',
          trackIds: ['t1', 't2'],
          type: 'album',
        },
      },
    });
    useOfflineStore.setState({
      downloadAlbum: downloadAlbumMock as never,
      isAlbumDownloading: () => false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips when the active server is unreachable', async () => {
    isActiveServerReachableMock.mockReturnValue(false);
    await resumeIncompleteOfflinePins();
    expect(downloadAlbumMock).not.toHaveBeenCalled();
  });

  it('skips pins that are already complete on disk', async () => {
    isOfflinePinCompleteMock.mockReturnValue(true);
    await resumeIncompleteOfflinePins();
    expect(downloadAlbumMock).not.toHaveBeenCalled();
  });

  it('re-queues downloadAlbum for incomplete persisted pins', async () => {
    resolveAlbumForServerMock.mockResolvedValue({
      album: { id: 'alb-1', name: 'Album', artist: 'Artist', artistId: 'a1', songCount: 2, duration: 2 },
      songs: [
        { id: 't1', title: 'One', artist: 'Artist', album: 'Album', albumId: 'alb-1', duration: 1 },
        { id: 't2', title: 'Two', artist: 'Artist', album: 'Album', albumId: 'alb-1', duration: 1 },
      ],
    });
    await resumeIncompleteOfflinePins();
    expect(downloadAlbumMock).toHaveBeenCalledWith(
      'alb-1',
      'Album',
      'Artist',
      undefined,
      undefined,
      expect.arrayContaining([
        expect.objectContaining({ id: 't1' }),
        expect.objectContaining({ id: 't2' }),
      ]),
      'srv-1',
      'album',
    );
  });
});
