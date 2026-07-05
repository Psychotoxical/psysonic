import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as libraryApi from '@/lib/api/library';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { useOfflineStore } from '@/features/offline/store/offlineStore';
import {
  fetchOfflineBrowsablePlaylists,
  loadOfflineBrowsablePlaylist,
  playlistsOfflineBrowseEnabled,
} from '@/features/offline/utils/offlinePlaylistBrowse';

vi.mock('@/lib/api/library', () => ({
  libraryGetTracksBatchChunked: vi.fn(),
}));

const libraryGetTracksBatchChunkedMock = vi.mocked(libraryApi.libraryGetTracksBatchChunked);

function seedPlaylistPin(serverId = 'srv-1', indexKey = 'srv-1') {
  useAuthStore.setState({
    activeServerId: serverId,
    servers: [{
      id: serverId,
      name: 'Test',
      url: 'https://music.test',
      username: 'u',
      password: 'p',
    }],
  });
  useLibraryIndexStore.setState({ masterEnabled: true });
  useOfflineStore.setState({
    albums: {
      [`${indexKey}:pl-1`]: {
        id: 'pl-1',
        serverId: indexKey,
        name: 'Road mix',
        artist: '',
        trackIds: ['t1', 't2'],
        type: 'playlist',
      },
    },
  });
  useLocalPlaybackStore.setState({
    entries: {
      [`${indexKey}:t1`]: {
        serverIndexKey: indexKey,
        trackId: 't1',
        localPath: '/media/library/t1.mp3',
        layoutFingerprint: 'fp',
        sizeBytes: 1000,
        tier: 'library',
        cachedAt: 1,
        suffix: 'mp3',
        pinSource: { kind: 'playlist', sourceId: 'pl-1', displayName: 'Road mix' },
      },
      [`${indexKey}:t2`]: {
        serverIndexKey: indexKey,
        trackId: 't2',
        localPath: '/media/library/t2.mp3',
        layoutFingerprint: 'fp',
        sizeBytes: 1000,
        tier: 'library',
        cachedAt: 1,
        suffix: 'mp3',
        pinSource: { kind: 'playlist', sourceId: 'pl-1', displayName: 'Road mix' },
      },
    },
  });
}

describe('offlinePlaylistBrowse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ activeServerId: null, servers: [] });
    useLibraryIndexStore.setState({ masterEnabled: false });
    useOfflineStore.setState({ albums: {} });
    useLocalPlaybackStore.setState({ entries: {} });
  });

  it('playlistsOfflineBrowseEnabled is true when cached playlist bytes exist', () => {
    seedPlaylistPin();
    expect(playlistsOfflineBrowseEnabled('srv-1')).toBe(true);
    expect(playlistsOfflineBrowseEnabled(null)).toBe(false);
  });

  it('fetchOfflineBrowsablePlaylists returns cached regular playlists only', async () => {
    seedPlaylistPin();
    libraryGetTracksBatchChunkedMock.mockResolvedValueOnce([
      {
        serverId: 'srv-1',
        id: 't1',
        title: 'A',
        artist: 'Ar',
        album: 'Al',
        albumId: 'al-1',
        durationSec: 100,
        syncedAt: 1,
        rawJson: {},
      },
      {
        serverId: 'srv-1',
        id: 't2',
        title: 'B',
        artist: 'Br',
        album: 'Bl',
        albumId: 'al-2',
        durationSec: 200,
        syncedAt: 1,
        rawJson: {},
      },
    ]);

    const playlists = await fetchOfflineBrowsablePlaylists('srv-1');
    expect(playlists).toHaveLength(1);
    expect(playlists[0]?.id).toBe('pl-1');
    expect(playlists[0]?.name).toBe('Road mix');
    expect(playlists[0]?.songCount).toBe(2);
    expect(playlists[0]?.duration).toBe(300);
  });

  it('loadOfflineBrowsablePlaylist preserves playlist track order', async () => {
    seedPlaylistPin();
    libraryGetTracksBatchChunkedMock.mockResolvedValueOnce([
      {
        serverId: 'srv-1',
        id: 't1',
        title: 'A',
        artist: 'Ar',
        album: 'Al',
        albumId: 'al-1',
        durationSec: 100,
        syncedAt: 1,
        rawJson: {},
      },
      {
        serverId: 'srv-1',
        id: 't2',
        title: 'B',
        artist: 'Br',
        album: 'Bl',
        albumId: 'al-2',
        durationSec: 200,
        syncedAt: 1,
        rawJson: {},
      },
    ]);

    const loaded = await loadOfflineBrowsablePlaylist('pl-1', 'srv-1');
    expect(loaded?.playlist.name).toBe('Road mix');
    expect(loaded?.songs.map(s => s.id)).toEqual(['t1', 't2']);
  });
});
