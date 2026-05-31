import { searchSongsPaged } from '../api/subsonicSearch';
import type { SubsonicSong } from '../api/subsonicTypes';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ndListSongs } from '../api/navidromeBrowse';
import { runLocalSongBrowse } from '../utils/library/advancedSearchLocal';
import {
  BROWSE_TEXT_DEBOUNCE_NETWORK_MS,
  BROWSE_TEXT_DEBOUNCE_RACE_MS,
  browseRaceCountsSongs,
  loadMoreLocalBrowseSongs,
  raceBrowseWithLocalFallback,
  runLocalBrowseSongPage,
  runNetworkBrowseSongPage,
} from '../utils/library/browseTextSearch';
import { useAuthStore } from '../store/authStore';
import { useLibraryIndexStore } from '../store/libraryIndexStore';

const PAGE_SIZE = 50;

async function fetchBrowseAllPage(
  serverId: string | null | undefined,
  offset: number,
): Promise<SubsonicSong[]> {
  const local = await runLocalSongBrowse(serverId, offset, PAGE_SIZE);
  if (local) return local;
  try {
    return await ndListSongs(offset, offset + PAGE_SIZE, 'title', 'ASC');
  } catch {
    return searchSongsPaged('', PAGE_SIZE, offset);
  }
}

export type SongBrowseListRestore = {
  query: string;
  songs: SubsonicSong[];
  offset: number;
  hasMore: boolean;
  localSearchMode: boolean;
  browseUnsupported: boolean;
  hasSearched: boolean;
};

type UseSongBrowseListArgs = {
  enabled: boolean;
  initialRestore?: SongBrowseListRestore | null;
};

/** Tracks hub song browse — all-library paging or filtered text search. */
export function useSongBrowseList({ enabled, initialRestore }: UseSongBrowseListArgs) {
  const serverId = useAuthStore(s => s.activeServerId);
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));

  const [query, setQuery] = useState(() => initialRestore?.query ?? '');
  const [debouncedQuery, setDebouncedQuery] = useState(() => initialRestore?.query.trim() ?? '');
  const [songs, setSongs] = useState<SubsonicSong[]>(() => initialRestore?.songs ?? []);
  const [offset, setOffset] = useState(() => initialRestore?.offset ?? 0);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(() => initialRestore?.hasMore ?? true);
  const [browseUnsupported, setBrowseUnsupported] = useState(
    () => initialRestore?.browseUnsupported ?? false,
  );
  const [hasSearched, setHasSearched] = useState(() => initialRestore?.hasSearched ?? false);

  const requestSeqRef = useRef(0);
  const localSearchModeRef = useRef(initialRestore?.localSearchMode ?? false);
  const skipInitialFetchRef = useRef(initialRestore != null);

  useEffect(() => {
    if (!enabled) return;
    const debounceMs = indexEnabled ? BROWSE_TEXT_DEBOUNCE_RACE_MS : BROWSE_TEXT_DEBOUNCE_NETWORK_MS;
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), debounceMs);
    return () => window.clearTimeout(timer);
  }, [query, indexEnabled, enabled]);

  const fetchSongPage = useCallback(
    async (q: string, pageOffset: number, isStale: () => boolean): Promise<SubsonicSong[]> => {
      if (q === '') {
        return fetchBrowseAllPage(serverId, pageOffset);
      }

      if (pageOffset === 0 && indexEnabled && serverId) {
        const winner = await raceBrowseWithLocalFallback(
          isStale,
          () => runLocalBrowseSongPage(serverId, q, 0, PAGE_SIZE),
          () => runNetworkBrowseSongPage(q, 0, PAGE_SIZE),
          {
            surface: 'tracks_browse',
            query: q,
            indexEnabled,
            counts: browseRaceCountsSongs,
          },
        );
        if (isStale()) return [];
        if (winner) {
          localSearchModeRef.current = winner.source === 'local';
          return winner.result ?? [];
        }
        localSearchModeRef.current = false;
        return (await runNetworkBrowseSongPage(q, 0, PAGE_SIZE)) ?? [];
      }

      if (localSearchModeRef.current && serverId) {
        try {
          return await loadMoreLocalBrowseSongs(serverId, q, pageOffset, PAGE_SIZE);
        } catch {
          return [];
        }
      }

      return (await runNetworkBrowseSongPage(q, pageOffset, PAGE_SIZE)) ?? [];
    },
    [indexEnabled, serverId],
  );

  useEffect(() => {
    if (!enabled) return;
    if (skipInitialFetchRef.current) {
      skipInitialFetchRef.current = false;
      return;
    }

    let cancelled = false;
    setSongs([]);
    setOffset(0);
    setHasMore(true);
    setBrowseUnsupported(false);
    localSearchModeRef.current = false;

    const seq = ++requestSeqRef.current;
    const isStale = () => cancelled || seq !== requestSeqRef.current;
    setLoading(true);
    void (async () => {
      try {
        const page = await fetchSongPage(debouncedQuery, 0, isStale);
        if (isStale()) return;
        if (page.length === 0) {
          setHasMore(false);
          if (debouncedQuery === '') setBrowseUnsupported(true);
        } else {
          setSongs(page);
          setOffset(page.length);
          if (page.length < PAGE_SIZE) setHasMore(false);
        }
        setHasSearched(true);
      } catch {
        if (!isStale()) setHasMore(false);
      } finally {
        if (!isStale()) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, fetchSongPage, enabled]);

  const loadMore = useCallback(async () => {
    if (!enabled || loading || !hasMore) return;
    setLoading(true);
    const seq = ++requestSeqRef.current;
    const isStale = () => seq !== requestSeqRef.current;
    try {
      const page = await fetchSongPage(debouncedQuery, offset, isStale);
      if (isStale()) return;
      if (page.length === 0) {
        setHasMore(false);
      } else {
        setSongs(prev => {
          const seen = new Set(prev.map(s => s.id));
          const merged = [...prev];
          for (const s of page) if (!seen.has(s.id)) merged.push(s);
          return merged;
        });
        setOffset(o => o + page.length);
        if (page.length < PAGE_SIZE) setHasMore(false);
      }
    } catch {
      setHasMore(false);
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [enabled, loading, hasMore, debouncedQuery, offset, fetchSongPage]);

  return {
    query,
    setQuery,
    songs,
    offset,
    loading,
    hasMore,
    browseUnsupported,
    hasSearched,
    localSearchMode: localSearchModeRef.current,
    loadMore,
  };
}
