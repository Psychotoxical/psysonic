import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '../../store/authStore';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import {
  favoritesOfflineBrowseEnabled,
  hasOfflineBrowsingContent,
  isOfflineSidebarLibraryNavAllowed,
} from './favoritesOfflineBrowse';

describe('favoritesOfflineBrowse', () => {
  beforeEach(() => {
    useAuthStore.setState({
      favoritesOfflineEnabled: false,
      activeServerId: 'srv-1',
    });
    useLocalPlaybackStore.setState({ entries: {} });
  });

  it('favoritesOfflineBrowseEnabled requires setting and active server', () => {
    expect(favoritesOfflineBrowseEnabled()).toBe(false);
    useAuthStore.setState({ favoritesOfflineEnabled: true });
    expect(favoritesOfflineBrowseEnabled()).toBe(true);
    useAuthStore.setState({ activeServerId: null });
    expect(favoritesOfflineBrowseEnabled()).toBe(false);
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
