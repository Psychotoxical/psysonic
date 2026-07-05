import { libraryScopeCacheKeyForServer, librarySelectionForServer } from '@/lib/api/subsonicClient';
import type { ArtistCreditMode } from '@/lib/api/library';
import { fetchLocalArtistCatalogChunk } from './browseTextSearch';
import { scheduleAlbumBrowseBackgroundWork } from './albumBrowseBackground';
import { emitArtistsBrowseDebug } from './artistBrowseDebug';
import {
  ARTIST_BROWSE_BOOTSTRAP_CHUNK,
  artistBrowseBootstrapEligible,
  artistBrowseCatalogCacheKey,
  artistBrowseCatalogInflight,
  artistBrowseInitialLoadKey,
  fetchArtistBrowseCatalogDeduped,
  readArtistBrowseCatalogCache,
} from './artistBrowseInflight';

const DEFAULT_CREDIT_MODE: ArtistCreditMode = 'album';
const DEFAULT_LETTER_FILTER = 'ALL';

/** Warm the first artist catalog chunk after the sidebar library filter changes. */
export function prefetchArtistBrowseCatalogAfterFilterChange(
  serverId: string,
  libraryFilterVersion: number,
  indexEnabled: boolean,
): void {
  if (!serverId) return;
  if (!indexEnabled) return;
  if (!artistBrowseBootstrapEligible(DEFAULT_LETTER_FILTER, false)) return;

  const loadKey = artistBrowseInitialLoadKey(
    serverId,
    libraryFilterVersion,
    libraryScopeCacheKeyForServer(serverId),
    DEFAULT_CREDIT_MODE,
    DEFAULT_LETTER_FILTER,
    false,
    false,
  );
  if (readArtistBrowseCatalogCache(loadKey)) return;

  const bootKey = artistBrowseCatalogCacheKey(
    loadKey,
    ARTIST_BROWSE_BOOTSTRAP_CHUNK,
    200,
  );
  if (artistBrowseCatalogInflight(loadKey) || artistBrowseCatalogInflight(bootKey)) return;

  scheduleAlbumBrowseBackgroundWork(() => {
    emitArtistsBrowseDebug('catalog_prefetch_start', {
      libraryFilterVersion,
      libraryScopeCount: librarySelectionForServer(serverId).length,
    });
    void fetchArtistBrowseCatalogDeduped(bootKey, () =>
      fetchLocalArtistCatalogChunk(
        serverId,
        0,
        ARTIST_BROWSE_BOOTSTRAP_CHUNK,
        DEFAULT_CREDIT_MODE,
        DEFAULT_LETTER_FILTER,
      ),
    ).then(result => {
      if (result != null) {
        emitArtistsBrowseDebug('catalog_prefetch_done', { artistCount: result.artists.length });
      }
    });
  });
}
