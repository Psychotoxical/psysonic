import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../store/authStore';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import {
  favoritesOfflineBrowseEnabled,
  hasOfflineBrowsingContent,
  isOfflineSidebarLibraryNavAllowed,
  loadStarredFromLibraryIndex,
  mergeStarredFromServers,
  resolveAlbumForServer,
} from './favoritesOfflineBrowse';

const isActiveServerReachableMock = vi.fn(() => true);
const shouldAttemptSubsonicForServerMock = vi.fn((_serverId: string, _trackId?: string) => true);
vi.mock('../network/activeServerReachability', () => ({
  isActiveServerReachable: () => isActiveServerReachableMock(),
}));
vi.mock('../network/subsonicNetworkGuard', () => ({
  shouldAttemptSubsonicForServer: (serverId: string, trackId?: string) =>
    shouldAttemptSubsonicForServerMock(serverId, trackId),
}));

const getAlbumForServerMock = vi.fn();
const libraryAdvancedSearchMock = vi.fn();
const libraryGetTracksByAlbumMock = vi.fn();

vi.mock('../../api/subsonicLibrary', () => ({
  getAlbumForServer: (...args: unknown[]) => getAlbumForServerMock(...args),
}));

vi.mock('../../api/library', () => ({
  libraryAdvancedSearch: (...args: unknown[]) => libraryAdvancedSearchMock(...args),
  libraryGetTracksByAlbum: (...args: unknown[]) => libraryGetTracksByAlbumMock(...args),
}));

describe('favoritesOfflineBrowse', () => {
  beforeEach(() => {
    isActiveServerReachableMock.mockReturnValue(true);
    shouldAttemptSubsonicForServerMock.mockReturnValue(true);
    getAlbumForServerMock.mockReset();
    libraryGetTracksByAlbumMock.mockReset();
    libraryAdvancedSearchMock.mockReset();
    useAuthStore.setState({
      favoritesOfflineEnabled: false,
      activeServerId: 'srv-1',
      servers: [{ id: 'srv-1', name: 'A', url: 'https://a.test', username: 'u', password: 'p' }],
    });
    useLocalPlaybackStore.setState({ entries: {} });
  });

  it('favoritesOfflineBrowseEnabled requires setting and at least one indexed server', () => {
    expect(favoritesOfflineBrowseEnabled()).toBe(false);
    useAuthStore.setState({ favoritesOfflineEnabled: true });
    expect(favoritesOfflineBrowseEnabled()).toBe(true);
    useAuthStore.setState({ servers: [] });
    expect(favoritesOfflineBrowseEnabled()).toBe(false);
    useAuthStore.setState({
      favoritesOfflineEnabled: true,
      activeServerId: null,
      servers: [{ id: 'srv-2', name: 'B', url: 'https://b.test', username: 'u', password: 'p' }],
    });
    expect(favoritesOfflineBrowseEnabled()).toBe(true);
  });

  it('mergeStarredFromServers tags serverId and dedupes per server', () => {
    const merged = mergeStarredFromServers([
      {
        serverId: 'srv-1',
        starred: {
          albums: [{ id: 'alb-1', name: 'A', artist: 'X', artistId: 'art-1', songCount: 1, duration: 1 }],
          artists: [],
          songs: [{ id: 't-1', title: 'S', artist: 'X', album: 'A', albumId: 'alb-1', duration: 1 }],
        },
      },
      {
        serverId: 'srv-2',
        starred: {
          albums: [{ id: 'alb-1', name: 'B', artist: 'Y', artistId: 'art-2', songCount: 1, duration: 1 }],
          artists: [],
          songs: [{ id: 't-1', title: 'S2', artist: 'Y', album: 'B', albumId: 'alb-1', duration: 1 }],
        },
      },
    ]);
    expect(merged.albums).toHaveLength(2);
    expect(merged.albums.map(a => a.serverId)).toEqual(['srv-1', 'srv-2']);
    expect(merged.songs).toHaveLength(2);
    expect(merged.songs.map(s => s.serverId)).toEqual(['srv-1', 'srv-2']);
  });

  it('isOfflineSidebarLibraryNavAllowed keeps only favorites when offline', () => {
    expect(isOfflineSidebarLibraryNavAllowed('favorites', true)).toBe(true);
    expect(isOfflineSidebarLibraryNavAllowed('favorites', false)).toBe(false);
    expect(isOfflineSidebarLibraryNavAllowed('albums', true)).toBe(false);
  });

  it('loadStarredFromLibraryIndex omits artist entity (no artist.starred_at in index)', async () => {
    libraryAdvancedSearchMock.mockResolvedValue({
      albums: [{ id: 'alb-1', name: 'A', artist: 'X', artistId: 'art-1', serverId: 'srv-1' }],
      artists: [{ id: 'art-99', name: 'Not A Favorite', serverId: 'srv-1' }],
      tracks: [{ id: 't-1', title: 'S', artist: 'X', album: 'A', albumId: 'alb-1', durationSec: 1, serverId: 'srv-1' }],
    });

    const starred = await loadStarredFromLibraryIndex('srv-1');
    expect(libraryAdvancedSearchMock).toHaveBeenCalledWith(expect.objectContaining({
      entityTypes: ['album', 'track'],
      starredOnly: true,
    }));
    expect(starred.artists).toEqual([]);
    expect(starred.songs).toHaveLength(1);
  });

  it('resolveAlbumForServer uses library index when network fails', async () => {
    useAuthStore.setState({ favoritesOfflineEnabled: true });
    shouldAttemptSubsonicForServerMock.mockReturnValue(true);
    getAlbumForServerMock.mockRejectedValue(new Error('Network Error'));
    libraryGetTracksByAlbumMock.mockResolvedValue([
      {
        id: 't1',
        title: 'Track',
        artist: 'Artist',
        album: 'Album',
        albumId: 'alb-1',
        artistId: 'art-1',
        durationSec: 200,
        serverId: 'srv-1',
      },
    ]);
    libraryAdvancedSearchMock.mockResolvedValue({
      albums: [{
        id: 'alb-1',
        name: 'Album',
        artist: 'Artist',
        artistId: 'art-1',
        serverId: 'srv-1',
      }],
      artists: [],
      tracks: [],
    });

    const result = await resolveAlbumForServer('srv-1', 'alb-1');
    expect(result?.album.id).toBe('alb-1');
    expect(result?.songs).toHaveLength(1);
    expect(getAlbumForServerMock).toHaveBeenCalledWith('srv-1', 'alb-1');
  });

  it('resolveAlbumForServer prefers full network album over partial library index', async () => {
    useAuthStore.setState({ favoritesOfflineEnabled: true });
    shouldAttemptSubsonicForServerMock.mockReturnValue(true);
    libraryGetTracksByAlbumMock.mockResolvedValue([
      {
        id: 't1',
        title: 'Indexed only',
        artist: 'Artist',
        album: 'Album',
        albumId: 'alb-1',
        durationSec: 100,
        serverId: 'srv-1',
      },
    ]);
    getAlbumForServerMock.mockResolvedValue({
      album: { id: 'alb-1', name: 'Album', artist: 'Artist', artistId: 'art-1', songCount: 3, duration: 600 },
      songs: [
        { id: 't1', title: 'One', artist: 'Artist', album: 'Album', albumId: 'alb-1', duration: 200 },
        { id: 't2', title: 'Two', artist: 'Artist', album: 'Album', albumId: 'alb-1', duration: 200 },
        { id: 't3', title: 'Three', artist: 'Artist', album: 'Album', albumId: 'alb-1', duration: 200 },
      ],
    });

    const result = await resolveAlbumForServer('srv-1', 'alb-1');
    expect(getAlbumForServerMock).toHaveBeenCalledWith('srv-1', 'alb-1');
    expect(result?.songs).toHaveLength(3);
    expect(result?.songs.map(s => s.id)).toEqual(['t1', 't2', 't3']);
  });

  it('resolveAlbumForServer uses library index when server is unreachable', async () => {
    useAuthStore.setState({ favoritesOfflineEnabled: true });
    shouldAttemptSubsonicForServerMock.mockReturnValue(false);
    libraryGetTracksByAlbumMock.mockResolvedValue([
      {
        id: 't1',
        title: 'Offline track',
        artist: 'Artist',
        album: 'Album',
        albumId: 'alb-1',
        durationSec: 200,
        serverId: 'srv-1',
      },
    ]);
    libraryAdvancedSearchMock.mockResolvedValue({
      albums: [{
        id: 'alb-1',
        name: 'Album',
        artist: 'Artist',
        artistId: 'art-1',
        serverId: 'srv-1',
      }],
      artists: [],
      tracks: [],
    });

    const result = await resolveAlbumForServer('srv-1', 'alb-1');
    expect(result?.songs).toHaveLength(1);
    expect(getAlbumForServerMock).not.toHaveBeenCalled();
  });

  it('resolveAlbumForServer falls back to network when index misses', async () => {
    useAuthStore.setState({ favoritesOfflineEnabled: true });
    isActiveServerReachableMock.mockReturnValue(true);
    libraryGetTracksByAlbumMock.mockResolvedValue([]);
    getAlbumForServerMock.mockResolvedValue({
      album: { id: 'alb-2', name: 'Net', artist: 'A', artistId: 'a1', songCount: 1, duration: 1 },
      songs: [{ id: 't2', title: 'T', artist: 'A', album: 'Net', albumId: 'alb-2', duration: 1 }],
    });

    const result = await resolveAlbumForServer('srv-1', 'alb-2');
    expect(result?.album.id).toBe('alb-2');
    expect(getAlbumForServerMock).toHaveBeenCalledWith('srv-1', 'alb-2');
  });

  it('hasOfflineBrowsingContent includes favorite-auto bytes when browse is enabled', () => {
    expect(hasOfflineBrowsingContent({})).toBe(false);
    useAuthStore.setState({ favoritesOfflineEnabled: true });
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/fav/t1.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'favorite-auto',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    expect(hasOfflineBrowsingContent({})).toBe(true);
  });
});
