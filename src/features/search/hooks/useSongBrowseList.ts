import { searchSongsPagedForServer } from '@/lib/api/subsonicSearch';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ndListSongsForServer } from '@/lib/api/navidromeBrowse';
import { runLocalSongBrowse, runLocalSongScopeBrowse } from '@/lib/library/advancedSearchLocal';
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
import {
  getLibraryBrowseScope,
  type LibraryBrowseScope,
} from '@/lib/library/libraryBrowseScope';
import { emitTrackBrowseDebug, trackBrowseTimed } from '@/lib/library/trackBrowseDebug';
import { useLibraryScopeSyncRevision } from '@/store/offlineLocalLibrarySyncRevision';
import { readyLibraryServerKeys } from '@/lib/library/libraryReady';
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';
import {
  readSongBrowsePageCache,
  writeSongBrowsePageCache,
} from '@/features/search/hooks/songBrowsePageCache';

const PAGE_SIZE = 50;
const BROWSE_READINESS_CHANGED = Symbol('browse-readiness-changed');
const BROWSE_READINESS_RETRY_DELAY_MS = 250;
const BROWSE_READINESS_RETRY_LIMIT = 20;

async function withBrowseReadinessRetry<T>(
  run: () => Promise<T>,
  isStale: () => boolean,
): Promise<T> {
  let readinessRetries = 0;
  while (true) {
    try {
      return await run();
    } catch (error) {
      if (
        error !== BROWSE_READINESS_CHANGED
        || isStale()
        || readinessRetries >= BROWSE_READINESS_RETRY_LIMIT
      ) {
        throw error;
      }
      readinessRetries += 1;
      emitTrackBrowseDebug('browse_readiness_retry', { attempt: readinessRetries });
      await new Promise(resolve => window.setTimeout(resolve, BROWSE_READINESS_RETRY_DELAY_MS));
    }
  }
}

type BrowseAllPage = {
  songs: SubsonicSong[];
  hasMore: boolean;
  local: boolean;
  nextCursor?: string | null;
};

const browseAllPageInflight = new Map<string, Promise<BrowseAllPage>>();

async function fetchBrowseAllPage(
  serverId: string | null | undefined,
  browseScope: LibraryBrowseScope,
  offset: number,
  cursor?: string | null,
  syncRevision = 0,
  freshness = '',
): Promise<BrowseAllPage> {
  const scopeFingerprint = browseScope.fingerprint;
  const key = [
    serverId ?? '',
    scopeFingerprint,
    String(syncRevision),
    freshness,
    String(offset),
    cursor ?? '',
  ].join('\u0001');
  const cached = readSongBrowsePageCache(key);
  if (cached) {
    emitTrackBrowseDebug('browse_page_cache_hit', {
      offset,
      cursor: cursor != null,
      songCount: cached.songs.length,
    });
    return { ...cached, local: true };
  }
  const existing = browseAllPageInflight.get(key);
  if (existing) return existing;
  const request = (async (): Promise<BrowseAllPage> => {
    const browseServerId = browseScope.anchorServerId;
    if (!browseServerId) throw BROWSE_READINESS_CHANGED;
    const scoped = await trackBrowseTimed(
      'local_scope_page',
      () => runLocalSongScopeBrowse(browseServerId, PAGE_SIZE, cursor, browseScope),
      { offset, cursor: cursor != null },
    );
    if (scoped) {
      writeSongBrowsePageCache(key, scoped);
      return { ...scoped, local: true };
    }
    if (browseScope.multiServer) throw BROWSE_READINESS_CHANGED;
    const local = await trackBrowseTimed(
      'local_advanced_page',
      () => runLocalSongBrowse(browseServerId, offset, PAGE_SIZE, browseScope),
      { offset },
    );
    if (local) {
      const page = { songs: local, hasMore: local.length === PAGE_SIZE };
      writeSongBrowsePageCache(key, page);
      return { ...page, local: true };
    }
    try {
      const songs = await trackBrowseTimed(
        'network_navidrome_page',
        () => ndListSongsForServer(browseServerId, offset, offset + PAGE_SIZE, 'title', 'ASC'),
        { offset },
      );
      return { songs, hasMore: songs.length === PAGE_SIZE, local: false };
    } catch {
      const songs = await trackBrowseTimed(
        'network_search_page',
        () => searchSongsPagedForServer(browseServerId, '', PAGE_SIZE, offset),
        { offset },
      );
      return { songs, hasMore: songs.length === PAGE_SIZE, local: false };
    }
  })();
  browseAllPageInflight.set(key, request);
  const clearInflight = () => {
    if (browseAllPageInflight.get(key) === request) browseAllPageInflight.delete(key);
  };
  void request.then(clearInflight, clearInflight);
  return request;
}

export type SongBrowseListRestore = {
  browseScopeFingerprint: string;
  librarySyncRevision: number;
  query: string;
  songs: SubsonicSong[];
  offset: number;
  hasMore: boolean;
  browseCursor?: string | null;
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
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const libraryBrowseScopeVersion = useAuthStore(s => s.libraryBrowseScopeVersion);
  const browseScope = useMemo(() => {
    void libraryBrowseScopeVersion;
    void serverId;
    return getLibraryBrowseScope();
  }, [libraryBrowseScopeVersion, serverId]);
  const browseServerId = browseScope.anchorServerId;
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(browseServerId));
  const offlineBrowseActive = useOfflineBrowseContext().active;
  const offlineBrowseReloadTs = useOfflineBrowseReloadToken();
  const offlineLocalBrowseReloadKey = useOfflineLocalBrowseReloadKey(
    serverId,
    offlineBrowseActive,
  );
  const browseScopeServerIds = browseScope.serverIds;
  const librarySyncRevision = useLibraryScopeSyncRevision(
    browseScopeServerIds.length > 0 ? browseScopeServerIds : (serverId ? [serverId] : []),
  );
  const validInitialRestore = initialRestore
    && initialRestore.browseScopeFingerprint === browseScope.fingerprint
    && initialRestore.librarySyncRevision === librarySyncRevision
    ? initialRestore
    : null;

  const [debouncedQuery, setDebouncedQuery] = useState(
    () => validInitialRestore?.query.trim() ?? searchQuery.trim(),
  );
  const [songs, setSongs] = useState<SubsonicSong[]>(() => validInitialRestore?.songs ?? []);
  const [offset, setOffset] = useState(() => validInitialRestore?.offset ?? 0);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(() => validInitialRestore?.hasMore ?? true);
  const [browseCursor, setBrowseCursor] = useState<string | null>(
    () => validInitialRestore?.browseCursor ?? null,
  );
  const [browseUnsupported, setBrowseUnsupported] = useState(
    () => validInitialRestore?.browseUnsupported ?? false,
  );
  const [hasSearched, setHasSearched] = useState(() => validInitialRestore?.hasSearched ?? false);

  const requestSeqRef = useRef(0);
  const localSearchModeRef = useRef(validInitialRestore?.localSearchMode ?? false);
  const browseCursorRef = useRef<string | null>(validInitialRestore?.browseCursor ?? null);
  const loadedScopeFingerprintRef = useRef(
    validInitialRestore?.browseScopeFingerprint ?? browseScope.fingerprint,
  );
  const loadedSyncRevisionRef = useRef(
    validInitialRestore?.librarySyncRevision ?? librarySyncRevision,
  );
  const [resultProvenance, setResultProvenance] = useState({
    browseScopeFingerprint: validInitialRestore?.browseScopeFingerprint ?? browseScope.fingerprint,
    librarySyncRevision: validInitialRestore?.librarySyncRevision ?? librarySyncRevision,
  });
  const browsePageMetaRef = useRef<{ hasMore: boolean; local: boolean }>({ hasMore: true, local: false });
  /** Keep stashed songs until the user edits the scoped query (survives fetchSongPage identity changes). */
  const holdRestoredListRef = useRef(validInitialRestore != null);
  const heldRestoredQueryRef = useRef(validInitialRestore?.query.trim() ?? '');

  const restoreQueryHoldRef = useRef(
    validInitialRestore?.query.trim() ? validInitialRestore.query.trim() : null,
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
      if (!browseServerId) throw BROWSE_READINESS_CHANGED;

      if (q === '') {
        const page = await fetchBrowseAllPage(
          browseServerId,
          browseScope,
          pageOffset,
          browseCursorRef.current,
          librarySyncRevision,
          `${musicLibraryFilterVersion}:${libraryBrowseScopeVersion}`,
        );
        if (isStale()) return [];
        browseCursorRef.current = page.nextCursor ?? null;
        setBrowseCursor(browseCursorRef.current);
        browsePageMetaRef.current = { hasMore: page.hasMore, local: page.local };
        localSearchModeRef.current = page.local;
        return page.songs;
      }

      if (pageOffset === 0 && indexEnabled && browseServerId) {
        if (getLibraryBrowseScope().multiServer) {
          const local = await runLocalBrowseSongPage(browseServerId, q, 0, PAGE_SIZE, browseScope);
          if (isStale()) return [];
          if (local == null) throw BROWSE_READINESS_CHANGED;
          localSearchModeRef.current = true;
          return local;
        }
        const winner = await raceBrowseWithLocalFallback(
          isStale,
          () => runLocalBrowseSongPage(browseServerId, q, 0, PAGE_SIZE, browseScope),
          () => runNetworkBrowseSongPage(q, 0, PAGE_SIZE, browseServerId),
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
        return (await runNetworkBrowseSongPage(q, 0, PAGE_SIZE, browseServerId)) ?? [];
      }

      if (localSearchModeRef.current && browseServerId) {
        try {
          return await loadMoreLocalBrowseSongs(browseServerId, q, pageOffset, PAGE_SIZE, browseScope);
        } catch {
          return [];
        }
      }

      return (await runNetworkBrowseSongPage(q, pageOffset, PAGE_SIZE, browseServerId)) ?? [];
    },
    [browseScope, browseServerId, indexEnabled, musicLibraryFilterVersion, libraryBrowseScopeVersion, librarySyncRevision, offlineBrowseActive, serverId],
  );

  useEffect(() => {
    if (!enabled) return;
    let discardRestoredList = false;

    if (holdRestoredListRef.current) {
      const expected = heldRestoredQueryRef.current;
      const restoreContextChanged = loadedScopeFingerprintRef.current !== browseScope.fingerprint
        || loadedSyncRevisionRef.current !== librarySyncRevision;
      if (searchQuery.trim() !== expected || debouncedQuery !== expected || restoreContextChanged) {
        holdRestoredListRef.current = false;
        if (restoreContextChanged) {
          discardRestoredList = true;
          loadedScopeFingerprintRef.current = browseScope.fingerprint;
          loadedSyncRevisionRef.current = librarySyncRevision;
          setResultProvenance({
            browseScopeFingerprint: browseScope.fingerprint,
            librarySyncRevision,
          });
          localSearchModeRef.current = false;
          browseCursorRef.current = null;
          browsePageMetaRef.current = { hasMore: true, local: false };
        }
      } else {
        return;
      }
    }

    let cancelled = false;
    const seq = ++requestSeqRef.current;
    const isStale = () => cancelled || seq !== requestSeqRef.current;
    void (async () => {
      try {
        if (discardRestoredList) {
          setSongs([]);
          setOffset(0);
          setBrowseCursor(null);
          setBrowseUnsupported(false);
          setHasMore(true);
          setHasSearched(false);
        }
        if (!offlineBrowseActive && !browseServerId) {
          if (isStale()) return;
          localSearchModeRef.current = false;
          browseCursorRef.current = null;
          browsePageMetaRef.current = { hasMore: false, local: false };
          setSongs([]);
          setOffset(0);
          setBrowseCursor(null);
          setBrowseUnsupported(true);
          setHasMore(false);
          setHasSearched(true);
          setLoading(false);
          loadedScopeFingerprintRef.current = browseScope.fingerprint;
          loadedSyncRevisionRef.current = librarySyncRevision;
          return;
        }
        if (
          !offlineBrowseActive
          && indexEnabled
          && browseServerId
          && browseScope.multiServer
          && (await readyLibraryServerKeys(browseScope.serverIds)) == null
        ) {
          if (!isStale()) {
            if (loadedScopeFingerprintRef.current !== browseScope.fingerprint) {
              loadedScopeFingerprintRef.current = browseScope.fingerprint;
              loadedSyncRevisionRef.current = librarySyncRevision;
              setResultProvenance({
                browseScopeFingerprint: browseScope.fingerprint,
                librarySyncRevision,
              });
              localSearchModeRef.current = false;
              browseCursorRef.current = null;
              browsePageMetaRef.current = { hasMore: false, local: false };
              setSongs([]);
              setOffset(0);
              setBrowseCursor(null);
              setBrowseUnsupported(false);
              setHasMore(false);
              setHasSearched(true);
            }
            setLoading(false);
          }
          return;
        }
        if (isStale()) return;
        localSearchModeRef.current = false;
        browseCursorRef.current = null;
        browsePageMetaRef.current = { hasMore: true, local: false };
        setLoading(true);
        emitTrackBrowseDebug('load_effect_start', {
          queryActive: debouncedQuery !== '',
          serverId: browseServerId,
          indexEnabled,
          offset: 0,
        });
        const page = await withBrowseReadinessRetry(
          () => fetchSongPage(debouncedQuery, 0, isStale),
          isStale,
        );
        if (isStale()) return;
        loadedScopeFingerprintRef.current = browseScope.fingerprint;
        loadedSyncRevisionRef.current = librarySyncRevision;
        setResultProvenance({
          browseScopeFingerprint: browseScope.fingerprint,
          librarySyncRevision,
        });
        setSongs(page);
        setOffset(page.length);
        setBrowseCursor(browseCursorRef.current);
        setBrowseUnsupported(page.length === 0 && debouncedQuery === '');
        if (page.length === 0) {
          setHasMore(false);
        } else if (debouncedQuery === '') {
          setHasMore(browsePageMetaRef.current.hasMore);
        } else {
          setHasMore(page.length === PAGE_SIZE);
        }
        setHasSearched(true);
        emitTrackBrowseDebug('load_effect_done', {
          queryActive: debouncedQuery !== '',
          songCount: page.length,
          hasMore: debouncedQuery === '' ? browsePageMetaRef.current.hasMore : page.length === PAGE_SIZE,
          local: localSearchModeRef.current,
        });
      } catch {
        emitTrackBrowseDebug('load_effect_error', { queryActive: debouncedQuery !== '' });
      } finally {
        if (!isStale()) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, searchQuery, fetchSongPage, enabled, indexEnabled, musicLibraryFilterVersion, libraryBrowseScopeVersion, librarySyncRevision, offlineBrowseReloadTs, offlineLocalBrowseReloadKey, offlineBrowseActive, browseScope, browseServerId, serverId]);

  const loadMore = useCallback(async () => {
    if (!enabled || loading || !hasMore) return;
    setLoading(true);
    const seq = ++requestSeqRef.current;
    const isStale = () => seq !== requestSeqRef.current;
    emitTrackBrowseDebug('load_more_start', {
      queryActive: debouncedQuery !== '',
      offset,
      cursor: browseCursorRef.current != null,
    });
    try {
      const page = await withBrowseReadinessRetry(
        () => fetchSongPage(debouncedQuery, offset, isStale),
        isStale,
      );
      if (isStale()) return;
      if (page.length === 0) {
        setHasMore(false);
      } else {
        setSongs(prev => {
          const seen = new Set(prev.map(ownedEntityKey));
          const merged = [...prev];
          for (const s of page) {
            const key = ownedEntityKey(s);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(s);
          }
          return merged;
        });
        setOffset(o => o + page.length);
        if (debouncedQuery === '') {
          setHasMore(browsePageMetaRef.current.hasMore);
        } else if (page.length < PAGE_SIZE) {
          setHasMore(false);
        }
        emitTrackBrowseDebug('load_more_done', {
          queryActive: debouncedQuery !== '',
          pageSongCount: page.length,
          hasMore: debouncedQuery === '' ? browsePageMetaRef.current.hasMore : page.length === PAGE_SIZE,
          local: localSearchModeRef.current,
        });
      }
    } catch {
      emitTrackBrowseDebug('load_more_error', { queryActive: debouncedQuery !== '' });
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
    browseCursor,
    loading,
    hasMore,
    browseUnsupported,
    hasSearched,
    // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
    // eslint-disable-next-line react-hooks/refs
    localSearchMode: localSearchModeRef.current,
    resultBrowseScopeFingerprint: resultProvenance.browseScopeFingerprint,
    resultLibrarySyncRevision: resultProvenance.librarySyncRevision,
    loadMore,
  };
}
