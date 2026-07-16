import { clearArtistBrowseCatalogCache } from '@/lib/library/artistBrowseInflight';
import { prefetchAlbumBrowseCatalogAfterFilterChange } from '@/lib/library/albumBrowseCatalogPrefetch';
import { prefetchArtistBrowseCatalogAfterFilterChange } from '@/lib/library/artistBrowseCatalogPrefetch';
import {
  registerMusicLibraryCatalogReloadHandler,
  runMusicLibraryCatalogReloadHandler,
  scheduleMusicLibraryFilterVersionBump,
} from '@/store/musicLibraryFilterNotify';
import { offlineLocalLibrarySyncRevision } from '@/store/offlineLocalLibrarySyncRevision';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import {
  buildBrowseLibraryScopePairs,
  libraryScopeFingerprint,
} from '@/lib/library/libraryBrowseScope';
import { isNavigatorOfflineHint } from '@/lib/network/navigatorOnlineHint';
import { registerLibraryServerConnectionPublisher } from '@/lib/network/libraryServerReachability';

/**
 * App-layer seam wiring the store's music-library filter/selection change to the
 * `src/lib/library` browse-catalog helpers (evict stale artist cache, warm the
 * first album/artist chunk). Registered once at module load via a side-effect
 * import from `AppShell`.
 *
 * The store deliberately does not import these helpers itself: `src/lib` is the
 * dependency floor, and a store → lib/library edge (with the existing lib → store
 * data-access edges) would form large import cycles. Inverting it here keeps the
 * store clean and the graph acyclic.
 */
registerMusicLibraryCatalogReloadHandler((serverId, indexEnabled, version) => {
  clearArtistBrowseCatalogCache();
  const syncRevision = offlineLocalLibrarySyncRevision(serverId);
  prefetchAlbumBrowseCatalogAfterFilterChange(serverId, version, indexEnabled, syncRevision);
  prefetchArtistBrowseCatalogAfterFilterChange(serverId, version, indexEnabled, syncRevision);
});

registerLibraryServerConnectionPublisher((indexKey, connection) => {
  useLibraryIndexStore.getState().mergeConnections({ [indexKey]: connection });
});

function currentBrowseFingerprint(): string {
  const runtime = useLibraryIndexStore.getState();
  return libraryScopeFingerprint(buildBrowseLibraryScopePairs(
    useAuthStore.getState(),
    runtime,
    { navigatorOffline: isNavigatorOfflineHint() },
  ));
}

let previousBrowseFingerprint = currentBrowseFingerprint();

function scheduleReloadIfBrowseScopeChanged(): void {
  const next = currentBrowseFingerprint();
  if (next === previousBrowseFingerprint) return;
  previousBrowseFingerprint = next;
  scheduleMusicLibraryFilterVersionBump(() => {
    useAuthStore.setState(state => ({
      musicLibraryFilterVersion: state.musicLibraryFilterVersion + 1,
    }));
    const auth = useAuthStore.getState();
    const serverId = auth.activeServerId ?? auth.musicLibraryServerIds[0];
    if (!serverId) return;
    runMusicLibraryCatalogReloadHandler(
      serverId,
      useLibraryIndexStore.getState().isIndexEnabled(serverId),
      auth.musicLibraryFilterVersion,
    );
  });
}

useAuthStore.subscribe(scheduleReloadIfBrowseScopeChanged);
useLibraryIndexStore.subscribe(scheduleReloadIfBrowseScopeChanged);
window.addEventListener('online', scheduleReloadIfBrowseScopeChanged);
window.addEventListener('offline', scheduleReloadIfBrowseScopeChanged);
