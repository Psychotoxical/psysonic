import type { ReactNode } from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeFeedSnapshot } from '@/features/home/store/homeFeedCache';

const homeMocks = vi.hoisted(() => ({
  connection: { status: 'checking' as 'checking' | 'connected' | 'disconnected' },
  loadHomeFeedWithStatus: vi.fn(),
  loadHomeChronologicalFeed: vi.fn(),
  loadMoreHomeAlbums: vi.fn(),
  mainstageTrace: { enabled: false, revision: 0 },
  reportCachedHomeDiagnostics: vi.fn(),
  scope: { key: 'scope', version: 1 },
  unavailableServerIds: new Set<string>(),
}));

vi.mock('@/features/album', () => ({
  AlbumRow: ({
    title,
    albums,
    onLoadMore,
  }: {
    title: string;
    albums: Array<{ name: string }>;
    onLoadMore?: () => void;
  }) => (
    <div data-testid={`home-row-${title}`}>
      {albums.map(album => album.name).join(',')}
      {onLoadMore && (
        <button type="button" data-testid={`load-more-${title}`} onClick={onLoadMore}>
          load more
        </button>
      )}
    </div>
  ),
  LosslessAlbumsRail: () => null,
}));
vi.mock('@/features/home/components/Hero', () => ({
  default: ({ albums }: { albums: Array<{ name: string }> }) => (
    <div data-testid="home-hero">{albums.map(album => album.name).join(',')}</div>
  ),
}));
vi.mock('@/features/home/components/SongRail', () => ({ default: () => null }));
vi.mock('@/features/home/components/BecauseYouLikeRail', () => ({ default: () => null }));
vi.mock('@/features/home/components/MainstageDiagnosticFrame', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/features/playback/utils/mixRatingFilter', () => ({
  filterAlbumsByMixRatingsAcrossServers: vi.fn(async albums => albums),
  getMixMinRatingsConfigFromAuth: () => ({
    enabled: false, minSong: 0, minAlbum: 0, minArtist: 0,
  }),
}));
vi.mock('@/lib/perf/perfFlags', () => ({
  usePerfProbeFlags: () => ({
    disableMainstageRails: false,
    disableHomeAlbumRows: false,
    disableHomeSongRails: false,
    disableMainstageRailArtwork: true,
    disableHomeRailArtwork: false,
    disableMainstageHero: false,
    disableMainstageGridCards: true,
    disableHomeArtworkFx: false,
    disableHomeArtworkClip: false,
  }),
}));
vi.mock('@/lib/perf/psyLabDebugTraces', () => ({
  usePsyLabDebugTraceEnabled: () => homeMocks.mainstageTrace.enabled,
  usePsyLabDebugTraceRevision: () => homeMocks.mainstageTrace.revision,
  usePsyLabDebugTraces: () => ({ mainstage: homeMocks.mainstageTrace.enabled }),
}));
vi.mock('@/lib/perf/perfTelemetry', () => ({ bumpPerfCounter: vi.fn() }));
vi.mock('@/cover/useLibraryCoverPrefetch', () => ({ useLibraryCoverPrefetch: vi.fn() }));
vi.mock('@/cover/warmDiskPeek', () => ({
  primeAlbumCoversForDisplay: vi.fn(async () => undefined),
  warmHomeMainstageCovers: vi.fn(async () => undefined),
}));
vi.mock('@/features/home/store/becauseYouLikeCache', () => ({
  readBecauseYouLikeCache: () => null,
}));
vi.mock('@/lib/hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => ({ status: homeMocks.connection.status }),
}));
vi.mock('@/features/offline', () => ({
  useOfflineBrowseContext: () => ({ active: false }),
  useOfflineBrowseReloadToken: () => 0,
  useDevOfflineBrowseStore: (selector: (state: { forceOffline: boolean }) => unknown) => (
    selector({ forceOffline: false })
  ),
}));
vi.mock('@/lib/library/libraryBrowseScope', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/library/libraryBrowseScope')>()),
  deriveLibraryBrowseScope: () => ({
    anchorServerId: 'server-a',
    pairs: [{ serverId: 'server-a', libraryId: 'library-a' }],
    fingerprint: homeMocks.scope.key,
  }),
}));
vi.mock('@/lib/network/serverReachability', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/network/serverReachability')>()),
  useUnavailableServerIds: () => homeMocks.unavailableServerIds,
}));
vi.mock('@/features/home/pages/homeFeedLoader', () => ({
  deriveHomeFeedScope: () => ({ serverIds: ['server-a'], scopeKey: homeMocks.scope.key }),
  loadHomeFeedWithStatus: homeMocks.loadHomeFeedWithStatus,
  loadHomeChronologicalFeed: homeMocks.loadHomeChronologicalFeed,
  loadMoreHomeAlbums: homeMocks.loadMoreHomeAlbums,
  patchHomeChronologicalFeed: (snapshot: HomeFeedSnapshot) => snapshot,
  preserveHomeChronologicalFeeds: (snapshot: HomeFeedSnapshot) => snapshot,
}));
vi.mock('@/features/home/pages/homeCoverPrefetch', () => ({
  groupHomeCoverPrefetchBuckets: () => [],
  homeDiscoverCoverPrefetchBucket: () => ({}),
  shouldOfferHomeLoadMore: () => false,
}));
vi.mock('@/store/offlineLocalLibrarySyncRevision', () => ({
  useLibraryScopeSyncRevision: () => 0,
}));
vi.mock('@/features/home/pages/homeDiagnosticHelpers', () => ({
  homeSnapshotForEnabledCoverWarm: (snapshot: HomeFeedSnapshot) => snapshot,
  preserveDisabledHomeSections: (snapshot: HomeFeedSnapshot) => snapshot,
  reportCachedHomeDiagnostics: homeMocks.reportCachedHomeDiagnostics,
}));
vi.mock('@/app/startupSplash', () => ({ scheduleStartupSplashDismiss: vi.fn() }));

import Home from '@/features/home/pages/Home';
import {
  clearHomeFeedCache,
  readHomeFeedCache,
  writeHomeFeedCache,
} from '@/features/home/store/homeFeedCache';
import { useHomeStore, DEFAULT_HOME_SECTIONS } from '@/features/home/store/homeStore';
import { useAuthStore } from '@/store/authStore';
import { useMigrationStore } from '@/store/migrationStore';
import { makeServer } from '@/test/helpers/factories';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function snapshot(
  name: string,
  scopeKey = homeMocks.scope.key,
  scopeVersion = homeMocks.scope.version,
): HomeFeedSnapshot {
  return {
    scopeKey,
    scopeVersion,
    savedAt: 1,
    offsets: {
      starred: { 'server-a': 0 },
      recent: { offset: 0, hasMore: false },
      random: { 'server-a': 0 },
      mostPlayed: { 'server-a': 0 },
      recentlyPlayed: { offset: 0, hasMore: false },
    },
    starred: [],
    recent: [],
    random: [],
    heroAlbums: [{
      id: name, name, artist: 'Artist', artistId: 'artist', songCount: 1, duration: 1,
    }],
    mostPlayed: [],
    recentlyPlayed: [],
    randomArtists: [],
    discoverSongs: [],
  };
}

describe('Home startup feed loading', () => {
  beforeEach(() => {
    resetAuthStore();
    clearHomeFeedCache();
    homeMocks.connection.status = 'checking';
    homeMocks.scope = { key: 'scope', version: 1 };
    homeMocks.loadHomeFeedWithStatus.mockReset();
    homeMocks.loadHomeChronologicalFeed.mockReset();
    homeMocks.loadMoreHomeAlbums.mockReset();
    homeMocks.mainstageTrace.enabled = false;
    homeMocks.mainstageTrace.revision = 0;
    homeMocks.reportCachedHomeDiagnostics.mockReset();
    homeMocks.loadHomeChronologicalFeed.mockResolvedValue({
      status: 'success', albums: [], hasMore: false, durationMs: 0,
    });
    useMigrationStore.setState({ phase: 'idle' });
    useHomeStore.setState({ sections: DEFAULT_HOME_SECTIONS });
    const server = makeServer({ id: 'server-a' });
    useAuthStore.setState({
      servers: [server],
      activeServerId: server.id,
      libraryBrowseServerIds: [server.id],
      musicFoldersByServer: { [server.id]: [] },
      libraryBrowseSelectionByServer: { [server.id]: [] },
      libraryBrowseScopeVersion: 1,
    });
  });

  it('waits for migrations, retries on connection, and ignores invalidated loads', async () => {
    const beforeBlocked = deferred<{ snapshot: HomeFeedSnapshot; emptySnapshotReliable: boolean }>();
    const beforeConnected = deferred<{ snapshot: HomeFeedSnapshot; emptySnapshotReliable: boolean }>();
    const connected = deferred<{ snapshot: HomeFeedSnapshot; emptySnapshotReliable: boolean }>();
    homeMocks.loadHomeFeedWithStatus
      .mockReturnValueOnce(beforeBlocked.promise)
      .mockReturnValueOnce(beforeConnected.promise)
      .mockReturnValueOnce(connected.promise);

    const view = renderWithProviders(<Home />);
    expect(homeMocks.loadHomeFeedWithStatus).not.toHaveBeenCalled();

    await act(async () => {
      useMigrationStore.setState({ phase: 'completed' });
    });
    await waitFor(() => expect(homeMocks.loadHomeFeedWithStatus).toHaveBeenCalledTimes(1));

    await act(async () => {
      useMigrationStore.setState({ phase: 'inspecting' });
      beforeBlocked.resolve({ snapshot: snapshot('blocked-stale'), emptySnapshotReliable: true });
      await beforeBlocked.promise;
    });
    expect(readHomeFeedCache('scope', 1)).toBeNull();

    await act(async () => {
      useMigrationStore.setState({ phase: 'completed' });
    });
    await waitFor(() => expect(homeMocks.loadHomeFeedWithStatus).toHaveBeenCalledTimes(2));

    homeMocks.connection.status = 'connected';
    view.rerender(<Home />);
    await waitFor(() => expect(homeMocks.loadHomeFeedWithStatus).toHaveBeenCalledTimes(3));

    await act(async () => {
      beforeConnected.resolve({ snapshot: snapshot('connection-stale'), emptySnapshotReliable: true });
      await beforeConnected.promise;
    });
    expect(readHomeFeedCache('scope', 1)).toBeNull();

    await act(async () => {
      connected.resolve({ snapshot: snapshot('fresh'), emptySnapshotReliable: true });
      await connected.promise;
    });
    await waitFor(() => expect(readHomeFeedCache('scope', 1)?.heroAlbums[0]?.name).toBe('fresh'));
    expect(screen.getByTestId('home-hero')).toHaveTextContent('fresh');
  });

  it('keeps a fresh cached feed visible while preparing the next visit in the background', async () => {
    const { savedAt: _savedAt, ...cached } = snapshot('cached');
    writeHomeFeedCache(cached);
    homeMocks.loadHomeFeedWithStatus.mockResolvedValue({
      snapshot: snapshot('next-visit'),
      emptySnapshotReliable: true,
    });
    homeMocks.connection.status = 'connected';
    useMigrationStore.setState({ phase: 'completed' });

    renderWithProviders(<Home />);

    expect(screen.getByTestId('home-hero')).toHaveTextContent('cached');
    await waitFor(() => expect(homeMocks.loadHomeFeedWithStatus).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(readHomeFeedCache('scope', 1)?.heroAlbums[0]?.name).toBe('next-visit'));
    expect(screen.getByTestId('home-hero')).toHaveTextContent('cached');
  });

  it('replays diagnostics without restarting an in-flight cold feed', async () => {
    const coldFeed = deferred<{ snapshot: HomeFeedSnapshot; emptySnapshotReliable: boolean }>();
    homeMocks.mainstageTrace.enabled = true;
    homeMocks.connection.status = 'connected';
    homeMocks.loadHomeFeedWithStatus.mockReturnValue(coldFeed.promise);
    useMigrationStore.setState({ phase: 'completed' });

    const view = renderWithProviders(<Home />);
    await waitFor(() => expect(homeMocks.loadHomeFeedWithStatus).toHaveBeenCalledTimes(1));

    homeMocks.mainstageTrace.revision += 1;
    view.rerender(<Home />);

    await waitFor(() => expect(homeMocks.loadHomeFeedWithStatus).toHaveBeenCalledTimes(1));
    await act(async () => {
      coldFeed.resolve({ snapshot: snapshot('fresh'), emptySnapshotReliable: true });
      await coldFeed.promise;
    });
  });

  it('does not apply a load-more result after the active scope changes', async () => {
    const oldScopeLoadMore = deferred<HomeFeedSnapshot>();
    const newScopeFeed = deferred<{ snapshot: HomeFeedSnapshot; emptySnapshotReliable: boolean }>();
    homeMocks.connection.status = 'connected';
    homeMocks.loadHomeFeedWithStatus
      .mockResolvedValueOnce({ snapshot: snapshot('old-scope'), emptySnapshotReliable: true })
      .mockReturnValueOnce(newScopeFeed.promise);
    homeMocks.loadMoreHomeAlbums.mockReturnValueOnce(oldScopeLoadMore.promise);
    useMigrationStore.setState({ phase: 'completed' });

    renderWithProviders(<Home />);
    await waitFor(() => expect(screen.getByTestId('home-hero')).toHaveTextContent('old-scope'));

    const user = userEvent.setup();
    await user.click(screen.getByTestId('load-more-Personal Favorites'));
    expect(homeMocks.loadMoreHomeAlbums).toHaveBeenCalledTimes(1);

    homeMocks.scope = { key: 'new-scope', version: 2 };
    await act(async () => {
      useAuthStore.setState({ libraryBrowseScopeVersion: 2 });
    });
    await waitFor(() => expect(homeMocks.loadHomeFeedWithStatus).toHaveBeenCalledTimes(2));
    await act(async () => {
      newScopeFeed.resolve({
        snapshot: snapshot('new-scope', 'new-scope', 2),
        emptySnapshotReliable: true,
      });
      await newScopeFeed.promise;
    });
    await waitFor(() => expect(screen.getByTestId('home-hero')).toHaveTextContent('new-scope'));

    await act(async () => {
      oldScopeLoadMore.resolve(snapshot('stale-load-more', 'scope', 1));
      await oldScopeLoadMore.promise;
    });

    expect(screen.getByTestId('home-hero')).toHaveTextContent('new-scope');
    expect(readHomeFeedCache('new-scope', 2)?.heroAlbums[0]?.name).toBe('new-scope');
  });
});
