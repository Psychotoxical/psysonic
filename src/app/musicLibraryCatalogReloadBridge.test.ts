import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { flushMusicLibraryFilterVersionBumpForTests } from '@/store/musicLibraryFilterNotify';
import { resetAuthStore } from '@/test/helpers/storeReset';

vi.mock('@/lib/library/artistBrowseInflight', () => ({
  clearArtistBrowseCatalogCache: vi.fn(),
}));
vi.mock('@/lib/library/albumBrowseCatalogPrefetch', () => ({
  prefetchAlbumBrowseCatalogAfterFilterChange: vi.fn(),
}));
vi.mock('@/lib/library/artistBrowseCatalogPrefetch', () => ({
  prefetchArtistBrowseCatalogAfterFilterChange: vi.fn(),
}));
vi.mock('@/store/offlineLocalLibrarySyncRevision', () => ({
  offlineLocalLibrarySyncRevision: () => 0,
}));

import './musicLibraryCatalogReloadBridge';

function readyStatus(serverId: string) {
  return {
    serverId,
    libraryScope: '',
    syncPhase: 'ready',
    capabilityFlags: 0,
    libraryTier: '',
  };
}

describe('musicLibraryCatalogReloadBridge runtime scope updates', () => {
  beforeEach(() => {
    resetAuthStore();
    useLibraryIndexStore.setState({ statusByServer: {}, connectionByServer: {} });
    useLibraryIndexStore.getState().replaceConnections({});
  });

  it('coalesces readiness and reachability transitions into one version bump', () => {
    const serverId = useAuthStore.getState().addServer({
      name: 'Server', url: 'https://music.example', username: 'u', password: 'p',
    });
    useAuthStore.getState().setActiveServer(serverId);

    useLibraryIndexStore.getState().replaceStatuses({
      'music.example': readyStatus('music.example'),
    });
    useLibraryIndexStore.getState().replaceConnections({ 'music.example': 'online' });

    expect(useAuthStore.getState().musicLibraryFilterVersion).toBe(0);
    flushMusicLibraryFilterVersionBumpForTests();
    expect(useAuthStore.getState().musicLibraryFilterVersion).toBe(1);
  });

  it('bumps again when reconnect restores browse membership', () => {
    const serverId = useAuthStore.getState().addServer({
      name: 'Server', url: 'https://music.example', username: 'u', password: 'p',
    });
    useAuthStore.getState().setActiveServer(serverId);
    useLibraryIndexStore.getState().replaceStatuses({
      'music.example': readyStatus('music.example'),
    });
    useLibraryIndexStore.getState().replaceConnections({ 'music.example': 'offline' });
    flushMusicLibraryFilterVersionBumpForTests();
    const versionBeforeReconnect = useAuthStore.getState().musicLibraryFilterVersion;

    useLibraryIndexStore.getState().replaceConnections({ 'music.example': 'online' });
    flushMusicLibraryFilterVersionBumpForTests();
    expect(useAuthStore.getState().musicLibraryFilterVersion).toBe(versionBeforeReconnect + 1);
  });
});
