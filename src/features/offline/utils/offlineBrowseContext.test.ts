import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import {
  buildOfflineBrowseContext,
  computeOfflineBrowseCapabilities,
  offlineBrowseNavFlags,
} from '@/features/offline/utils/offlineBrowseContext';

vi.mock('@/features/offline/utils/offlineLocalBrowse', () => ({
  offlineLocalBrowseEnabled: vi.fn(() => false),
  countLocalBrowsableTracks: vi.fn(() => 0),
}));

vi.mock('@/features/offline/utils/offlinePlaylistBrowse', () => ({
  playlistsOfflineBrowseEnabled: vi.fn(() => false),
}));

import { offlineLocalBrowseEnabled } from '@/features/offline/utils/offlineLocalBrowse';
import { playlistsOfflineBrowseEnabled } from '@/features/offline/utils/offlinePlaylistBrowse';

describe('offlineBrowseContext', () => {
  beforeEach(() => {
    useAuthStore.setState({
      favoritesOfflineEnabled: false,
      activeServerId: 'srv-1',
    } as Partial<ReturnType<typeof useAuthStore.getState>>);
    useLibraryIndexStore.setState({ masterEnabled: true });
    useLocalPlaybackStore.setState({ entries: {} });
    vi.mocked(offlineLocalBrowseEnabled).mockReturnValue(false);
    vi.mocked(playlistsOfflineBrowseEnabled).mockReturnValue(false);
  });

  it('computeOfflineBrowseCapabilities returns all false when nothing enabled', () => {
    const caps = computeOfflineBrowseCapabilities({
      activeServerId: 'srv-1',
      favoritesOfflineEnabled: false,
      offlineAlbums: {},
      playerStats: false,
    });
    expect(caps).toEqual({
      localLibrary: false,
      favorites: false,
      playlists: false,
      manualPins: false,
      playerStats: false,
    });
  });

  it('favorites capability uses cross-server index when setting is on', () => {
    useAuthStore.setState({
      favoritesOfflineEnabled: true,
      servers: [{ id: 'srv-2', name: 'B', url: 'https://b.test', username: 'u', password: 'p' }],
      activeServerId: null,
    });
    const caps = computeOfflineBrowseCapabilities({
      activeServerId: null,
      favoritesOfflineEnabled: true,
      offlineAlbums: {},
      playerStats: false,
    });
    expect(caps.favorites).toBe(true);
  });

  it('buildOfflineBrowseContext sets hasBrowseCapability from capabilities', () => {
    vi.mocked(offlineLocalBrowseEnabled).mockReturnValue(true);
    const caps = computeOfflineBrowseCapabilities({
      activeServerId: 'srv-1',
      favoritesOfflineEnabled: false,
      offlineAlbums: {},
      playerStats: true,
    });
    const ctx = buildOfflineBrowseContext({
      active: true,
      serverId: 'srv-1',
      capabilities: caps,
      connStatus: 'disconnected',
      hasBrowsingContent: true,
    });
    expect(ctx.hasBrowseCapability).toBe(true);
    expect(ctx.capabilities.playerStats).toBe(true);
  });

  it('offlineBrowseNavFlags maps capability fields for sidebar', () => {
    const flags = offlineBrowseNavFlags({
      localLibrary: true,
      favorites: false,
      playlists: true,
      manualPins: true,
      playerStats: false,
    });
    expect(flags).toEqual({
      favoritesOfflineBrowse: false,
      localLibraryBrowse: true,
      playlistsOfflineBrowse: true,
      playerStatsBrowse: false,
      hasManualOfflineContent: true,
    });
  });
});
