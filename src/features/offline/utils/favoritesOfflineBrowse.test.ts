import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import {
  favoritesOfflineBrowseEnabled,
  hasOfflineBrowsingContent,
} from '@/features/offline/utils/favoritesOfflineBrowse';
import {
  isOfflineSidebarLibraryNavAllowed,
  isOfflineSidebarNavAllowed,
  isOfflineSidebarSystemNavAllowed,
} from '@/features/offline/utils/offlineNavPolicy';
import {
  loadStarredFromLibraryIndex,
  mergeStarredFromServers,
} from '@/features/offline/utils/offlineStarredLoad';
import { resolveAlbumForServer } from '@/features/offline/utils/offlineMediaResolve';

const isActiveServerReachableMock = vi.fn(() => true);
const shouldAttemptSubsonicForServerMock = vi.fn((_serverId: string, _trackId?: string) => true);
vi.mock('@/lib/network/activeServerReachability', () => ({
  isActiveServerReachable: () => isActiveServerReachableMock(),
}));
vi.mock('@/lib/network/subsonicNetworkGuard', () => ({
  shouldAttemptSubsonicForServer: (serverId: string, trackId?: string) =>
    shouldAttemptSubsonicForServerMock(serverId, trackId),
}));

const getAlbumForServerMock = vi.fn();
const libraryAdvancedSearchMock = vi.fn();
const libraryGetTracksByAlbumMock = vi.fn();
const libraryGetTracksBatchChunkedMock = vi.fn();

vi.mock('@/lib/api/subsonicLibrary', () => ({
  getAlbumForServer: (...args: unknown[]) => getAlbumForServerMock(...args),
}));

vi.mock('@/lib/api/library', () => ({
  libraryAdvancedSearch: (...args: unknown[]) => libraryAdvancedSearchMock(...args),
  libraryGetTracksByAlbum: (...args: unknown[]) => libraryGetTracksByAlbumMock(...args),
  libraryGetTracksBatchChunked: (...args: unknown[]) => libraryGetTracksBatchChunkedMock(...args),
}));

describe('favoritesOfflineBrowse', () => {
  beforeEach(() => {
    isActiveServerReachableMock.mockReturnValue(true);
    shouldAttemptSubsonicForServerMock.mockReturnValue(true);
    getAlbumForServerMock.mockReset();
    libraryGetTracksByAlbumMock.mockReset();
    libraryAdvancedSearchMock.mockReset();
    libraryGetTracksBatchChunkedMock.mockReset();
    useLibraryIndexStore.setState({ masterEnabled: true });
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

  it('isOfflineSidebarLibraryNavAllowed gates offline sidebar entries', () => {
    expect(isOfflineSidebarLibraryNavAllowed('favorites', true)).toBe(true);
    expect(isOfflineSidebarLibraryNavAllowed('favorites', false)).toBe(false);
    expect(isOfflineSidebarLibraryNavAllowed('artists', false, true)).toBe(true);
    expect(isOfflineSidebarLibraryNavAllowed('allAlbums', false, true)).toBe(true);
    expect(isOfflineSidebarLibraryNavAllowed('tracks', false, true)).toBe(true);
    expect(isOfflineSidebarLibraryNavAllowed('tracks', false, false)).toBe(false);
    expect(isOfflineSidebarLibraryNavAllowed('allAlbums', false, false)).toBe(false);
    expect(isOfflineSidebarLibraryNavAllowed('offline', false, false)).toBe(true);
    expect(isOfflineSidebarLibraryNavAllowed('playlists', false, false, true)).toBe(true);
    expect(isOfflineSidebarLibraryNavAllowed('playlists', false, false, false)).toBe(false);
  });

  it('isOfflineSidebarSystemNavAllowed keeps help and player stats offline', () => {
    expect(isOfflineSidebarSystemNavAllowed('help', false)).toBe(true);
    expect(isOfflineSidebarSystemNavAllowed('statistics', true)).toBe(true);
    expect(isOfflineSidebarSystemNavAllowed('statistics', false)).toBe(false);
    expect(isOfflineSidebarNavAllowed('help', false, false, false)).toBe(true);
    expect(isOfflineSidebarNavAllowed('statistics', false, false, true)).toBe(true);
    expect(isOfflineSidebarNavAllowed('tracks', false, true, false)).toBe(true);
    expect(isOfflineSidebarNavAllowed('playlists', false, false, false, true)).toBe(true);
  });

  it('loadStarredFromLibraryIndex uses starred advanced search when not offline-bytes', async () => {
    libraryAdvancedSearchMock.mockResolvedValue({
      albums: [{ id: 'alb-1', name: 'A', artist: 'X', artistId: 'art-1', serverId: 'srv-1' }],
      tracks: [{ id: 't-1', title: 'S', artist: 'X', album: 'A', albumId: 'alb-1', durationSec: 1, serverId: 'srv-1' }],
      artists: [],
    });

    const starred = await loadStarredFromLibraryIndex('srv-1');
    expect(libraryAdvancedSearchMock).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'srv-1',
      entityTypes: ['album', 'track'],
      starredOnly: true,
    }));
    expect(libraryGetTracksBatchChunkedMock).not.toHaveBeenCalled();
    expect(starred.artists).toEqual([]);
    expect(starred.songs).toHaveLength(1);
  });

  it('loadStarredFromLibraryIndex prefers local bytes then starred filter when offline', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/library/a.test/a/al/t1.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'favorite-auto',
          cachedAt: 1,
          suffix: 'mp3',
        },
        'a.test:t2': {
          serverIndexKey: 'a.test',
          trackId: 't2',
          localPath: '/media/library/a.test/a/al/t2.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'favorite-auto',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    libraryGetTracksBatchChunkedMock.mockResolvedValue([
      {
        id: 't1',
        title: 'Starred',
        artist: 'X',
        album: 'A',
        albumId: 'alb-1',
        durationSec: 1,
        starredAt: 1,
        serverId: 'srv-1',
      },
      {
        id: 't2',
        title: 'Not starred',
        artist: 'X',
        album: 'A',
        albumId: 'alb-1',
        durationSec: 1,
        serverId: 'srv-1',
      },
    ]);
    libraryAdvancedSearchMock.mockResolvedValue({
      albums: [{
        id: 'alb-2',
        name: 'Album star only',
        artist: 'Y',
        artistId: 'art-2',
        starredAt: 1,
        serverId: 'srv-1',
      }],
      artists: [],
      tracks: [],
    });

    const starred = await loadStarredFromLibraryIndex('srv-1', true);

    expect(libraryGetTracksBatchChunkedMock).toHaveBeenCalled();
    expect(libraryAdvancedSearchMock).toHaveBeenCalled();
    expect(libraryAdvancedSearchMock).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'srv-1',
      entityTypes: ['album'],
      starredOnly: true,
      restrictAlbumIds: ['alb-1'],
    }));
    expect(starred.songs).toHaveLength(1);
    expect(starred.songs[0]?.id).toBe('t1');
    expect(starred.albums.map(a => a.id).sort()).toEqual(['alb-1', 'alb-2']);
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
