import { getArtists } from '../api/subsonicArtists';
import type { SubsonicArtist } from '../api/subsonicTypes';
import { useCallback, useEffect, useRef, useState } from 'react';
import { dedupeById } from '../utils/dedupeById';
import {
  fetchLocalArtistCatalogChunk,
  fetchNetworkStarredArtists,
} from '../utils/library/browseTextSearch';

/** Local-index artist catalog buffer grows by this many rows per background SQL chunk. */
export const ARTIST_CATALOG_CHUNK_SIZE = 200;

export type ArtistsBrowseMode = 'slice' | 'network';

export type UseArtistsBrowseCatalogArgs = {
  serverId: string | null | undefined;
  indexEnabled: boolean;
  starredOnly: boolean;
  musicLibraryFilterVersion: number;
};

export function useArtistsBrowseCatalog({
  serverId,
  indexEnabled,
  starredOnly,
  musicLibraryFilterVersion,
}: UseArtistsBrowseCatalogArgs) {
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
      const chunk = await fetchLocalArtistCatalogChunk(
        serverId,
        catalogOffsetRef.current,
        ARTIST_CATALOG_CHUNK_SIZE,
      );
      if (generation !== loadGenerationRef.current || chunk == null) return;
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
  }, [serverId]);

  useEffect(() => {
    let cancelled = false;
    const generation = ++loadGenerationRef.current;
    catalogOffsetRef.current = 0;
    catalogLoadingRef.current = false;
    setCatalogArtists([]);
    setCatalogHasMore(false);
    setCatalogLoadingMore(false);
    setBrowseMode('network');
    setLoading(true);

    void (async () => {
      try {
        if (starredOnly) {
          if (!cancelled && generation === loadGenerationRef.current) {
            setCatalogArtists(await fetchNetworkStarredArtists());
          }
          return;
        }
        if (indexEnabled && serverId) {
          const first = await fetchLocalArtistCatalogChunk(
            serverId,
            0,
            ARTIST_CATALOG_CHUNK_SIZE,
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
          setCatalogArtists(await getArtists());
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled && generation === loadGenerationRef.current) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [musicLibraryFilterVersion, indexEnabled, serverId, starredOnly]);

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
