import { searchSongsPaged } from '@/lib/api/subsonicSearch';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useCallback, useEffect, useRef, useState } from 'react';
import { dedupeById } from '@/lib/util/dedupeById';
import { ndListSongs } from '@/lib/api/navidromeBrowse';
import { runLocalSongBrowse } from '@/lib/library/advancedSearchLocal';
import {
  BROWSE_TEXT_DEBOUNCE_NETWORK_MS,
  BROWSE_TEXT_DEBOUNCE_RACE_MS,
  browseRaceCountsSongs,
  loadMoreLocalBrowseSongs,
  raceBrowseWithLocalFallback,
  runLocalBrowseSongPage,
  runNetworkBrowseSongPage,
} from '@/lib/library/browseTextSearch';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import {
  fetchOfflineLocalBrowsableSongPage,
  offlineLocalBrowseEnabled,
  searchOfflineLocalBrowsableSongs,
  useOfflineBrowseContext,
  useOfflineBrowseReloadToken,
} from '@/features/offline';
import { useOfflineLocalBrowseReloadKey } from '@/store/localPlaybackBrowseRevision';
import { useBrowseLibraryScope } from '@/store/useBrowseLibraryScope';
import type { LibraryScopePair } from '@/lib/api/library';

const PAGE_SIZE = 50;

async function fetchBrowseAllPage(
  serverId: string | null | undefined,
  offset: number,
  scopePairs?: LibraryScopePair[],
  localOnly = false,
): Promise<SubsonicSong[]> {
  const local = await runLocalSongBrowse(serverId, offset, PAGE_SIZE, scopePairs);
  if (local) return local;
  if (localOnly) return [];
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
  /** Header scoped browse query (wide title/artist/album search). */
  searchQuery: string;
  initialRestore?: SongBrowseListRestore | null;
};

/** Tracks hub song browse — all-library paging or filtered text search. */
export function useSongBrowseList({ enabled, searchQuery, initialRestore }: UseSongBrowseListArgs) {
  const serverId = useAuthStore(s => s.activeServerId);
  const browseScope = useBrowseLibraryScope();
  const browseServerId = browseScope.anchorServerId || serverId;
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));
  const offlineBrowseActive = useOfflineBrowseContext().active;
  const offlineBrowseReloadTs = useOfflineBrowseReloadToken();
  const offlineLocalBrowseReloadKey = useOfflineLocalBrowseReloadKey(
    serverId,
    offlineBrowseActive,
  );

  const [debouncedQuery, setDebouncedQuery] = useState(
    () => initialRestore?.query.trim() ?? searchQuery.trim(),
  );
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
  /** Keep stashed songs until the user edits the scoped query (survives fetchSongPage identity changes). */
  const holdRestoredListRef = useRef(initialRestore != null);
  const heldRestoredQueryRef = useRef(initialRestore?.query.trim() ?? '');

  const restoreQueryHoldRef = useRef(
    initialRestore?.query.trim() ? initialRestore.query.trim() : null,
  );
  useEffect(() => {
    if (!enabled) return;
    const incoming = searchQuery.trim();
    if (incoming !== '') {
      restoreQueryHoldRef.current = null;
    }
    const effectiveQuery = incoming || restoreQueryHoldRef.current || '';
    const debounceMs = indexEnabled ? BROWSE_TEXT_DEBOUNCE_RACE_MS : BROWSE_TEXT_DEBOUNCE_NETWORK_MS;
    const timer = window.setTimeout(() => setDebouncedQuery(effectiveQuery), debounceMs);
    return () => window.clearTimeout(timer);
  }, [searchQuery, indexEnabled, enabled]);

  const fetchSongPage = useCallback(
    async (q: string, pageOffset: number, isStale: () => boolean): Promise<SubsonicSong[]> => {
      if (offlineBrowseActive && serverId && offlineLocalBrowseEnabled(serverId)) {
        localSearchModeRef.current = true;
        if (q === '') {
          const page = await fetchOfflineLocalBrowsableSongPage(serverId, pageOffset, PAGE_SIZE);
          return page?.songs ?? [];
        }
        return (await searchOfflineLocalBrowsableSongs(serverId, q, pageOffset, PAGE_SIZE)) ?? [];
      }

      if (q === '') {
        return fetchBrowseAllPage(
          browseServerId,
          pageOffset,
          browseScope.pairs,
          browseScope.multiServer,
        );
      }

      if (pageOffset === 0 && browseScope.multiServer && browseServerId) {
        localSearchModeRef.current = true;
        return (await runLocalBrowseSongPage(
          browseServerId,
          q,
          0,
          PAGE_SIZE,
          browseScope.pairs,
        )) ?? [];
      }

      if (pageOffset === 0 && indexEnabled && browseServerId) {
        const winner = await raceBrowseWithLocalFallback(
          isStale,
          () => runLocalBrowseSongPage(browseServerId, q, 0, PAGE_SIZE, browseScope.pairs),
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

      if (localSearchModeRef.current && browseServerId) {
        try {
          return await loadMoreLocalBrowseSongs(
            browseServerId,
            q,
            pageOffset,
            PAGE_SIZE,
            browseScope.pairs,
          );
        } catch {
          return [];
        }
      }

      return (await runNetworkBrowseSongPage(q, pageOffset, PAGE_SIZE)) ?? [];
    },
    // musicLibraryFilterVersion is an intentional re-create trigger: the page
    // loaders read the active genre/library filter state internally, so the
    // callback must refresh when that version bumps even though it is unused here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [browseScope.fingerprint, browseScope.multiServer, browseServerId, indexEnabled, musicLibraryFilterVersion, offlineBrowseActive, serverId],
  );

  useEffect(() => {
    if (!enabled) return;

    if (holdRestoredListRef.current) {
      const expected = heldRestoredQueryRef.current;
      if (searchQuery.trim() !== expected || debouncedQuery !== expected) {
        holdRestoredListRef.current = false;
      } else {
        return;
      }
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
  }, [debouncedQuery, searchQuery, fetchSongPage, enabled, musicLibraryFilterVersion, offlineBrowseReloadTs, offlineLocalBrowseReloadKey]);

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
          return dedupeById([...prev, ...page]);
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

  // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
  // eslint-disable-next-line react-hooks/refs
  return {
    songs,
    offset,
    loading,
    hasMore,
    browseUnsupported,
    hasSearched,
    // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
    // eslint-disable-next-line react-hooks/refs
    localSearchMode: localSearchModeRef.current,
    loadMore,
  };
}
