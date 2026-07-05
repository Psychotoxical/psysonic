import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryTrackDto } from '@/lib/api/library';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import {
  countLocalBrowsableTracks,
  fetchOfflineLocalBrowsableSongPage,
  offlineLocalBrowseEnabled,
} from '@/features/offline/utils/offlineLocalBrowse';

const { libraryGetTracksBatchChunkedMock } = vi.hoisted(() => ({
  libraryGetTracksBatchChunkedMock: vi.fn(async (): Promise<LibraryTrackDto[]> => []),
}));

vi.mock('@/lib/api/library', () => ({
  libraryGetTracksBatchChunked: libraryGetTracksBatchChunkedMock,
  libraryGetTracksByAlbum: vi.fn(async () => []),
  libraryAdvancedSearch: vi.fn(async () => ({ albums: [], artists: [], tracks: [] })),
}));

describe('offlineLocalBrowse', () => {
  beforeEach(() => {
    useAuthStore.setState({
      activeServerId: 'srv-a',
      servers: [{ id: 'srv-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' }],
    });
    useLibraryIndexStore.setState({ masterEnabled: true });
    useLocalPlaybackStore.setState({ entries: {} });
    libraryGetTracksBatchChunkedMock.mockReset();
    libraryGetTracksBatchChunkedMock.mockResolvedValue([]);
  });

  it('offlineLocalBrowseEnabled requires index and local bytes', () => {
    expect(offlineLocalBrowseEnabled('srv-a')).toBe(false);
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/library/a.test/a/al/t1.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    expect(countLocalBrowsableTracks('srv-a')).toBe(1);
    expect(offlineLocalBrowseEnabled('srv-a')).toBe(true);
  });

  it('fetchOfflineLocalBrowsableSongPage pages local bytes alphabetically', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/library/a.test/a/al/t1.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
        },
        'a.test:t2': {
          serverIndexKey: 'a.test',
          trackId: 't2',
          localPath: '/media/library/a.test/a/al/t2.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    libraryGetTracksBatchChunkedMock.mockResolvedValue([
      {
        id: 't2', title: 'Beta', artist: 'A', album: 'Al', albumId: 'al-1',
        durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
      {
        id: 't1', title: 'Alpha', artist: 'A', album: 'Al', albumId: 'al-1',
        durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
    ]);

    const page = await fetchOfflineLocalBrowsableSongPage('srv-a', 0, 1);
    expect(page?.songs.map(s => s.id)).toEqual(['t1']);
    expect(page?.hasMore).toBe(true);
  });

});
