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
    try {
      if (offlineBrowseActive) {
        if (!offlineLocalBrowseEnabled(serverId)) return;
        const chunk = await fetchOfflineLocalArtistCatalogChunk(
          serverId,
          catalogOffsetRef.current,
          ARTIST_CATALOG_CHUNK_SIZE,
          creditMode,
          letterFilter,
        );
        if (generation !== loadGenerationRef.current) return;
        if (chunk == null) {
          if (append) setCatalogHasMore(false);
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
        return;
      }
      const chunk = await fetchLocalArtistCatalogChunk(
        serverId,
        catalogOffsetRef.current,
        ARTIST_CATALOG_CHUNK_SIZE,
        creditMode,
        letterFilter,
      );
      if (generation !== loadGenerationRef.current) return;
      if (chunk == null) {
        if (append) setCatalogHasMore(false);
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

    void (async () => {
      try {
        if (offlineBrowseActive) {
          if (!cancelled && generation === loadGenerationRef.current) {
            if (serverId && starredOnly && offlineLocalBrowseEnabled(serverId)) {
              try {
                setCatalogArtists(
                  await fetchStarredArtistsForBrowse(creditMode, serverId, true),
                );
              } catch {
                setCatalogArtists((await fetchOfflineLocalStarredArtists(serverId)) ?? []);
              }
            } else if (serverId && !starredOnly && offlineLocalBrowseEnabled(serverId)) {
              const first = await fetchOfflineLocalArtistCatalogChunk(
                serverId,
                0,
                ARTIST_CATALOG_CHUNK_SIZE,
                creditMode,
                letterFilter,
              );
              setCatalogArtists(first?.artists ?? []);
              catalogOffsetRef.current = first?.artists.length ?? 0;
              setCatalogHasMore(first?.hasMore ?? false);
            } else {
              setCatalogArtists([]);
              setCatalogHasMore(false);
            }
            setBrowseMode('slice');
          }
          return;
        }
        if (starredOnly) {
          if (!cancelled && generation === loadGenerationRef.current) {
            setCatalogArtists(
              await fetchStarredArtistsForBrowse(creditMode, serverId, indexEnabled),
            );
            setBrowseMode('network');
            setCatalogHasMore(false);
          }
          return;
        }
        if (indexEnabled && serverId) {
          const first = await fetchLocalArtistCatalogChunk(
            serverId,
            0,
            ARTIST_CATALOG_CHUNK_SIZE,
            creditMode,
            letterFilter,
          );
          if (cancelled || generation !== loadGenerationRef.current) return;
          if (first != null) {
            setBrowseMode('slice');
            setCatalogArtists(first.artists);
            catalogOffsetRef.current = first.artists.length;
            setCatalogHasMore(first.hasMore);
            return;
          }
        }
        if (!cancelled && generation === loadGenerationRef.current) {
          setCatalogArtists(await fetchNetworkArtistCatalog(creditMode));
        }
      } catch {
        /* ignore */
      } finally {
        if (generation === loadGenerationRef.current) {
          setLoading(false);
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
