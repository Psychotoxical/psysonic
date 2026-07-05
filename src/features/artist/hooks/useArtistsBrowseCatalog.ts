import type { SubsonicArtist } from '@/lib/api/subsonicTypes';
import type { ArtistCreditMode } from '@/lib/api/library';
import { useCallback, useEffect, useRef, useState } from 'react';
import { dedupeById } from '@/lib/util/dedupeById';
import {
  fetchLocalArtistCatalogChunk,
} from '@/lib/library/browseTextSearch';
import {
  fetchNetworkArtistCatalog,
  fetchStarredArtistsForBrowse,
} from '@/features/artist/utils/artistBrowseCreditMode';
import { useOfflineBrowseContext } from '@/features/offline';
import { useOfflineBrowseReloadToken } from '@/features/offline';
import {
  fetchOfflineLocalArtistCatalogChunk,
  fetchOfflineLocalStarredArtists,
  offlineLocalBrowseEnabled,
} from '@/features/offline';
import { librarySelectionForServer } from '@/lib/api/subsonicClient';
import {
  artistBrowseTimed,
  emitArtistsBrowseDebug,
} from '@/lib/library/artistBrowseDebug';

/** Local-index artist catalog buffer grows by this many rows per background SQL chunk. */
export const ARTIST_CATALOG_CHUNK_SIZE = 200;

export type ArtistsBrowseMode = 'slice' | 'network';

export type UseArtistsBrowseCatalogArgs = {
  serverId: string | null | undefined;
  indexEnabled: boolean;
  starredOnly: boolean;
  creditMode: ArtistCreditMode;
  letterFilter: string;
  musicLibraryFilterVersion: number;
};

export function useArtistsBrowseCatalog({
  serverId,
  indexEnabled,
  starredOnly,
  creditMode,
  letterFilter,
  musicLibraryFilterVersion,
}: UseArtistsBrowseCatalogArgs) {
  const offlineBrowseActive = useOfflineBrowseContext().active;
  const offlineBrowseReloadTs = useOfflineBrowseReloadToken();
  const [catalogArtists, setCatalogArtists] = useState<SubsonicArtist[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogHasMore, setCatalogHasMore] = useState(false);
  const [catalogLoadingMore, setCatalogLoadingMore] = useState(false);
  const [browseMode, setBrowseMode] = useState<ArtistsBrowseMode>('network');

  const loadGenerationRef = useRef(0);
  const catalogOffsetRef = useRef(0);
  const catalogLoadingRef = useRef(false);

  const loadCatalogChunk = useCallback(async (append: boolean) => {
    if (!serverId || catalogLoadingRef.current) return;
    const generation = loadGenerationRef.current;
    catalogLoadingRef.current = true;
    setCatalogLoadingMore(true);
    emitArtistsBrowseDebug('catalog_chunk_start', { append, offset: catalogOffsetRef.current });
    try {
      if (offlineBrowseActive) {
        if (!offlineLocalBrowseEnabled(serverId)) return;
        const chunk = await artistBrowseTimed(
          'offline_catalog_chunk',
          () => fetchOfflineLocalArtistCatalogChunk(
            serverId,
            catalogOffsetRef.current,
            ARTIST_CATALOG_CHUNK_SIZE,
            creditMode,
            letterFilter,
          ),
          { append, offset: catalogOffsetRef.current },
        );
        if (generation !== loadGenerationRef.current) return;
        if (chunk == null) {
          if (append) setCatalogHasMore(false);
          emitArtistsBrowseDebug('catalog_chunk_null', { append });
          return;
        }
        if (append) {
          setCatalogArtists(prev => {
            const merged = dedupeById([...prev, ...chunk.artists]);
            catalogOffsetRef.current = merged.length;
            return merged;
          });
        } else {
          setCatalogArtists(chunk.artists);
          catalogOffsetRef.current = chunk.artists.length;
        }
        setCatalogHasMore(chunk.hasMore);
        emitArtistsBrowseDebug('catalog_chunk_done', {
          append,
          artistCount: chunk.artists.length,
          hasMore: chunk.hasMore,
        });
        return;
      }
      const chunk = await artistBrowseTimed(
        'local_catalog_chunk',
        () => fetchLocalArtistCatalogChunk(
          serverId,
          catalogOffsetRef.current,
          ARTIST_CATALOG_CHUNK_SIZE,
          creditMode,
          letterFilter,
        ),
        { append, offset: catalogOffsetRef.current, creditMode, letterFilter },
      );
      if (generation !== loadGenerationRef.current) return;
      if (chunk == null) {
        if (append) setCatalogHasMore(false);
        emitArtistsBrowseDebug('catalog_chunk_null', { append });
        return;
      }
      if (append) {
        setCatalogArtists(prev => {
          const merged = dedupeById([...prev, ...chunk.artists]);
          catalogOffsetRef.current = merged.length;
          return merged;
        });
      } else {
        setCatalogArtists(chunk.artists);
        catalogOffsetRef.current = chunk.artists.length;
      }
      setCatalogHasMore(chunk.hasMore);
      setBrowseMode('slice');
      emitArtistsBrowseDebug('catalog_chunk_done', {
        append,
        artistCount: chunk.artists.length,
        hasMore: chunk.hasMore,
      });
    } finally {
      catalogLoadingRef.current = false;
      if (generation === loadGenerationRef.current) {
        setCatalogLoadingMore(false);
      }
    }
  }, [creditMode, letterFilter, offlineBrowseActive, serverId]);

  useEffect(() => {
    let cancelled = false;
    const generation = ++loadGenerationRef.current;
    catalogOffsetRef.current = 0;
    catalogLoadingRef.current = false;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCatalogArtists([]);
    setCatalogHasMore(false);
    setCatalogLoadingMore(false);
    setBrowseMode('network');
    setLoading(true);

    emitArtistsBrowseDebug('load_effect_start', {
      serverId,
      indexEnabled,
      libraryFilterVersion: musicLibraryFilterVersion,
      libraryScopeCount: serverId ? librarySelectionForServer(serverId).length : 0,
      offlineBrowseActive,
      starredOnly,
      creditMode,
      letterFilter,
    });

    void (async () => {
      try {
        if (offlineBrowseActive) {
          emitArtistsBrowseDebug('load_branch', { mode: 'offline' });
          if (!cancelled && generation === loadGenerationRef.current) {
            if (serverId && starredOnly && offlineLocalBrowseEnabled(serverId)) {
              try {
                setCatalogArtists(
                  await artistBrowseTimed(
                    'offline_starred',
                    () => fetchStarredArtistsForBrowse(creditMode, serverId, true),
                  ),
                );
              } catch {
                setCatalogArtists(
                  (await artistBrowseTimed(
                    'offline_starred_fallback',
                    () => fetchOfflineLocalStarredArtists(serverId),
                  )) ?? [],
                );
              }
            } else if (serverId && !starredOnly && offlineLocalBrowseEnabled(serverId)) {
              const first = await artistBrowseTimed(
                'offline_catalog_initial',
                () => fetchOfflineLocalArtistCatalogChunk(
                  serverId,
                  0,
                  ARTIST_CATALOG_CHUNK_SIZE,
                  creditMode,
                  letterFilter,
                ),
              );
              setCatalogArtists(first?.artists ?? []);
              catalogOffsetRef.current = first?.artists.length ?? 0;
              setCatalogHasMore(first?.hasMore ?? false);
            } else {
              setCatalogArtists([]);
              setCatalogHasMore(false);
            }
            setBrowseMode('slice');
            emitArtistsBrowseDebug('load_effect_done', {
              browseMode: 'slice',
              artistCount: catalogOffsetRef.current,
            });
          }
          return;
        }
        if (starredOnly) {
          emitArtistsBrowseDebug('load_branch', { mode: 'starred' });
          if (!cancelled && generation === loadGenerationRef.current) {
            const starred = await artistBrowseTimed(
              'starred_catalog',
              () => fetchStarredArtistsForBrowse(creditMode, serverId, indexEnabled),
            );
            setCatalogArtists(starred);
            setBrowseMode('network');
            setCatalogHasMore(false);
            emitArtistsBrowseDebug('load_effect_done', {
              browseMode: 'network',
              artistCount: starred.length,
              starredOnly: true,
            });
          }
          return;
        }
        if (indexEnabled && serverId) {
          emitArtistsBrowseDebug('load_branch', { mode: 'slice_try' });
          const first = await artistBrowseTimed(
            'local_catalog_initial',
            () => fetchLocalArtistCatalogChunk(
              serverId,
              0,
              ARTIST_CATALOG_CHUNK_SIZE,
              creditMode,
              letterFilter,
            ),
            { creditMode, letterFilter, chunkSize: ARTIST_CATALOG_CHUNK_SIZE },
          );
          if (cancelled || generation !== loadGenerationRef.current) return;
          if (first != null) {
            setBrowseMode('slice');
            setCatalogArtists(first.artists);
            catalogOffsetRef.current = first.artists.length;
            setCatalogHasMore(first.hasMore);
            emitArtistsBrowseDebug('load_effect_done', {
              browseMode: 'slice',
              artistCount: first.artists.length,
              hasMore: first.hasMore,
            });
            return;
          }
          emitArtistsBrowseDebug('slice_fallback', { reason: 'local_chunk_null' });
        }
        if (!cancelled && generation === loadGenerationRef.current) {
          emitArtistsBrowseDebug('load_branch', { mode: 'network' });
          const network = await artistBrowseTimed(
            'network_catalog',
            () => fetchNetworkArtistCatalog(creditMode),
            { creditMode },
          );
          setCatalogArtists(network);
          emitArtistsBrowseDebug('load_effect_done', {
            browseMode: 'network',
            artistCount: network.length,
          });
        }
      } catch {
        emitArtistsBrowseDebug('load_effect_error', {});
      } finally {
        if (generation === loadGenerationRef.current) {
          setLoading(false);
          emitArtistsBrowseDebug('loading_false', {
            artistCount: catalogOffsetRef.current,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [creditMode, letterFilter, musicLibraryFilterVersion, indexEnabled, offlineBrowseActive, offlineBrowseReloadTs, serverId, starredOnly]);

  return {
    catalogArtists,
    loading,
    catalogHasMore,
    catalogLoadingMore,
    browseMode,
    loadCatalogChunk,
    catalogLoadingRef,
  };
}
