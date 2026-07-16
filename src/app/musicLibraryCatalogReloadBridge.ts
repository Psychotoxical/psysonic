import { clearArtistBrowseCatalogCache } from '@/lib/library/artistBrowseInflight';
import { prefetchAlbumBrowseCatalogAfterFilterChange } from '@/lib/library/albumBrowseCatalogPrefetch';
import { prefetchArtistBrowseCatalogAfterFilterChange } from '@/lib/library/artistBrowseCatalogPrefetch';
import { registerMusicLibraryCatalogReloadHandler } from '@/store/musicLibraryFilterNotify';
import { offlineLocalLibrarySyncRevision } from '@/store/offlineLocalLibrarySyncRevision';

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
