import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '../../store/authStore';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import {
  favoritesOfflineBrowseEnabled,
  hasOfflineBrowsingContent,
  isOfflineSidebarLibraryNavAllowed,
  mergeStarredFromServers,
} from './favoritesOfflineBrowse';

describe('favoritesOfflineBrowse', () => {
  beforeEach(() => {
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
