import { getGenres } from '@/lib/api/subsonicGenres';
import type { SubsonicGenre } from '@/lib/api/subsonicTypes';
import type { ResultType, SearchOpts, Results } from '@/features/search/searchBrowseTypes';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom';
import { SlidersVertical, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AdvancedSearchFilterPanel from '@/features/search/components/AdvancedSearchFilterPanel';
import AdvancedSearchResults from '@/features/search/components/AdvancedSearchResults';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { isAdvancedSearchLeaveTargetPath } from '@/features/album';
import {
  isAdvancedSearchPath,
  isAdvancedSearchPanelPath,
  isTracksBrowsePath,
  useAdvancedSearchSessionStore,
  type AdvancedSearchSessionStash,
} from '@/store/advancedSearchSessionStore';
import {
  readAdvancedSearchRestore,
  shouldRestoreAdvancedSearchSession,
} from '@/lib/navigation/albumDetailNavigation';
import {
  clearAdvancedSearchLeaveSnapshots,
  consumeAdvancedSearchLeavingForDetail,
  readAdvancedSearchLeaveSnapshot,
  registerAdvancedSearchLeaveScrollProvider,
  registerAdvancedSearchSessionProvider,
  resolveAdvancedSearchLeaveSnapshot,
  type AdvancedSearchLeaveSnapshot,
} from '@/lib/navigation/advancedSearchScrollSnapshot';
import { restoreMainViewportScroll } from '@/lib/navigation/restoreMainViewportScroll';
import { OXIMEDIA_MOOD_SEARCH_ENABLED } from '@/lib/library/trackEnrichment';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import { useSongBrowseList, type SongBrowseListRestore } from '@/features/search/hooks/useSongBrowseList';
import { useAdvancedSearchRunner } from '@/features/search/hooks/useAdvancedSearchRunner';
import TracksPageChrome from '@/features/search/components/TracksPageChrome';
import SongBrowseSection from '@/features/search/components/SongBrowseSection';
import {
  useLiveSearchScopeStore,
  useScopedBrowseSearchQuery,
} from '@/store/liveSearchScopeStore';

const MOOD_UI_ENABLED = OXIMEDIA_MOOD_SEARCH_ENABLED;

function peekAdvancedSearchRestoreStash(
  navigationType: ReturnType<typeof useNavigationType>,
  locationState: unknown,
): AdvancedSearchSessionStash | null {
  if (!shouldRestoreAdvancedSearchSession(navigationType, locationState)) return null;
  return useAdvancedSearchSessionStore.getState().peekReturnStash();
}

/** Shared shell for `/search`, `/search/advanced`, and `/tracks` (pathname picks chrome). */
export default function SearchBrowsePage() {
  const perfFlags = usePerfProbeFlags();
  const { t } = useTranslation();
  const navigationType = useNavigationType();
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qFromUrl = params.get('q') ?? '';
  const showTracksChrome = isTracksBrowsePath(location.pathname);
  const showAdvancedPanel = isAdvancedSearchPanelPath(location.pathname);
  const restoreStash = peekAdvancedSearchRestoreStash(navigationType, location.state);
  const hadRestoreOnMountRef = useRef(restoreStash != null);
  const restoredFromStashRef = useRef(restoreStash != null);

  const [query, setQuery] = useState(() => restoreStash?.query ?? qFromUrl);
  const [genre, setGenre] = useState(() => restoreStash?.genre ?? '');
  const [yearFrom, setYearFrom] = useState(() => restoreStash?.yearFrom ?? '');
  const [yearTo, setYearTo] = useState(() => restoreStash?.yearTo ?? '');
  const [bpmFrom, setBpmFrom] = useState(() => restoreStash?.bpmFrom ?? '');
  const [bpmTo, setBpmTo] = useState(() => restoreStash?.bpmTo ?? '');
  const [moodGroup, setMoodGroup] = useState(() => restoreStash?.moodGroup ?? '');
  const [losslessOnly, setLosslessOnly] = useState(() => restoreStash?.losslessOnly ?? false);
  const [resultType, setResultType] = useState<ResultType>(() => restoreStash?.resultType ?? 'all');
  const [starredOnly, setStarredOnly] = useState(() => restoreStash?.starredOnly ?? false);
  const [genres, setGenres] = useState<SubsonicGenre[]>([]);
  const [results, setResults] = useState<Results | null>(() => restoreStash?.results ?? null);
  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const filteredResults = useMemo<Results | null>(() => {
    if (!results) return null;
    if (!starredOnly) return results;
    const isFav = (id: string, base: boolean | string | undefined) =>
      id in starredOverrides ? !!starredOverrides[id] : !!base;
    return {
      artists: results.artists.filter(a => isFav(a.id, a.starred)),
      albums: results.albums.filter(a => isFav(a.id, a.starred)),
      songs: results.songs.filter(s => isFav(s.id, s.starred)),
    };
  }, [results, starredOnly, starredOverrides]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(() => restoreStash?.hasSearched ?? false);
  const [genreNote, setGenreNote] = useState(() => restoreStash?.genreNote ?? false);
  // True while the current results came from the local index (drives the
  // pagination branch — local pages every result type, network only free-text).
  const [localMode, setLocalMode] = useState(() => restoreStash?.localMode ?? false);
  const [basicSearchMode, setBasicSearchMode] = useState(
    () => restoreStash?.basicSearchMode ?? (!showAdvancedPanel && !showTracksChrome),
  );
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const serverId = useAuthStore(s => s.activeServerId);
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));
  const [activeSearch, setActiveSearch] = useState<SearchOpts | null>(() => restoreStash?.activeSearch ?? null);
  const [songsServerOffset, setSongsServerOffset] = useState(() => restoreStash?.songsServerOffset ?? 0);
  const [songsHasMore, setSongsHasMore] = useState(() => restoreStash?.songsHasMore ?? false);
  const [loadingMoreSongs, setLoadingMoreSongs] = useState(false);

  const songBrowseInitialRestore: SongBrowseListRestore | null =
    restoreStash && showTracksChrome
      ? {
          query: restoreStash.query,
          songs: restoreStash.results?.songs ?? [],
          offset: restoreStash.songsServerOffset,
          hasMore: restoreStash.songsHasMore,
          localSearchMode: restoreStash.localMode,
          browseUnsupported: restoreStash.tracksBrowseUnsupported ?? false,
          hasSearched: restoreStash.hasSearched,
        }
      : null;

  const tracksLiveSearchInitRef = useRef(false);
  // React Compiler refs rule: ref used as a once-only init guard (checked before first assignment); not render data.
  // eslint-disable-next-line react-hooks/refs
  if (!tracksLiveSearchInitRef.current && restoreStash && showTracksChrome) {
    tracksLiveSearchInitRef.current = true;
    const store = useLiveSearchScopeStore.getState();
    store.setScope('tracks');
    if (restoreStash.query) store.setQuery(restoreStash.query);
  }

  const tracksSearchQuery = useScopedBrowseSearchQuery('tracks');
  const liveSearchQuery = useLiveSearchScopeStore(s => s.query);
  const tracksSearchActive =
    tracksSearchQuery.trim().length > 0 || liveSearchQuery.trim().length > 0;

  const songBrowse = useSongBrowseList({
    enabled: showTracksChrome,
    searchQuery: tracksSearchQuery,
    initialRestore: songBrowseInitialRestore,
  });

  const restoringSession =
    shouldRestoreAdvancedSearchSession(navigationType, location.state) || restoreStash != null;
  const leaveSnapshotRef = useRef<AdvancedSearchLeaveSnapshot | null>(
    restoringSession ? resolveAdvancedSearchLeaveSnapshot(restoreStash) : null,
  );
  // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
  // eslint-disable-next-line react-hooks/refs
  const scrollTopRestoreTargetRef = useRef(leaveSnapshotRef.current?.scrollTop ?? 0);
  const tracksSearchRestorePendingRef = useRef(
    !!(songBrowseInitialRestore?.query.trim()),
  );
  // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
  // eslint-disable-next-line react-hooks/refs
  const albumRowScrollLeftRestoreRef = useRef(leaveSnapshotRef.current?.albumRowScrollLeft ?? 0);
  // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
  // eslint-disable-next-line react-hooks/refs
  const artistRowScrollLeftRestoreRef = useRef(leaveSnapshotRef.current?.artistRowScrollLeft ?? 0);
  const mainScrollTopRef = useRef(0);
  const albumRowScrollLeftRef = useRef(0);
  const artistRowScrollLeftRef = useRef(0);
  const skipSearchAutoFocusRef = useRef(restoreStash != null);
  // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
  // eslint-disable-next-line react-hooks/refs
  const skipEnterAnimationRef = useRef(restoreStash != null || leaveSnapshotRef.current != null);
  // React Compiler refs rule: ref used as a once-only init guard (checked before first assignment); not render data.
  // eslint-disable-next-line react-hooks/refs
  const leaveRestoreUiFinishedRef = useRef(leaveSnapshotRef.current == null);
  const restoringTracksSearch = !!(restoreStash?.query.trim() && showTracksChrome);
  const [tracksChromeLayoutReady, setTracksChromeLayoutReady] = useState(
    // React Compiler refs rule: ref used as a once-only init guard (checked before first assignment); not render data.
    // eslint-disable-next-line react-hooks/refs
    () => !showTracksChrome || leaveSnapshotRef.current == null || restoringTracksSearch,
  );
  const [isLeaveRestorePending, setIsLeaveRestorePending] = useState(
    // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
    // eslint-disable-next-line react-hooks/refs
    () => leaveSnapshotRef.current != null,
  );
  const tracksDiscoveryHidden =
    tracksSearchActive
    || (isLeaveRestorePending && !!(restoreStash?.query.trim() || songBrowseInitialRestore?.query.trim()));

  const handleTracksChromeLayoutReady = useCallback(() => {
    setTracksChromeLayoutReady(true);
  }, []);

  const finishLeaveRestoreUi = useCallback(() => {
    if (leaveRestoreUiFinishedRef.current) return;
    leaveRestoreUiFinishedRef.current = true;
    leaveSnapshotRef.current = null;
    setIsLeaveRestorePending(false);
    // Defer stash teardown until after AppShell's route-change scroll reset effect.
    window.setTimeout(() => {
      clearAdvancedSearchLeaveSnapshots();
      if (hadRestoreOnMountRef.current) {
        useAdvancedSearchSessionStore.getState().clearReturnStash();
      }
    }, 0);
  }, []);

  const sessionRef = useRef<AdvancedSearchSessionStash>({
    query: '',
    genre: '',
    yearFrom: '',
    yearTo: '',
    bpmFrom: '',
    bpmTo: '',
    moodGroup: '',
    losslessOnly: false,
    resultType: 'all',
    starredOnly: false,
    results: null,
    hasSearched: false,
    activeSearch: null,
    localMode: false,
    songsServerOffset: 0,
    songsHasMore: false,
    genreNote: false,
    basicSearchMode: false,
    tracksBrowseMode: false,
    tracksBrowseUnsupported: false,
  });
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  sessionRef.current = {
    query: showTracksChrome ? liveSearchQuery : query,
    genre,
    yearFrom,
    yearTo,
    bpmFrom,
    bpmTo,
    moodGroup,
    losslessOnly,
    resultType,
    starredOnly,
    results: showTracksChrome
      ? { artists: [], albums: [], songs: songBrowse.songs }
      : results,
    hasSearched: showTracksChrome ? songBrowse.hasSearched : hasSearched,
    activeSearch,
    localMode: showTracksChrome ? songBrowse.localSearchMode : localMode,
    songsServerOffset: showTracksChrome ? songBrowse.offset : songsServerOffset,
    songsHasMore: showTracksChrome ? songBrowse.hasMore : songsHasMore,
    genreNote,
    basicSearchMode: showTracksChrome ? false : basicSearchMode,
    tracksBrowseMode: showTracksChrome,
    tracksBrowseUnsupported: showTracksChrome ? songBrowse.browseUnsupported : false,
  };

  useEffect(() => {
    const unregisterScroll = registerAdvancedSearchLeaveScrollProvider(() => ({
      scrollTop: mainScrollTopRef.current,
      albumRowScrollLeft: albumRowScrollLeftRef.current,
      artistRowScrollLeft: artistRowScrollLeftRef.current,
    }));
    const unregisterSession = registerAdvancedSearchSessionProvider(() => sessionRef.current);
    return () => {
      unregisterScroll();
      unregisterSession();
    };
  }, []);

  useEffect(() => {
    const el = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
    if (!el) return;
    const syncScroll = () => {
      mainScrollTopRef.current = el.scrollTop;
    };
    syncScroll();
    el.addEventListener('scroll', syncScroll, { passive: true });
    return () => el.removeEventListener('scroll', syncScroll);
  }, []);

  const { runBasicSearch, runSearch, loadMoreSongs } = useAdvancedSearchRunner({
    serverId,
    indexEnabled,
    loadingMoreSongs,
    songsHasMore,
    activeSearch,
    basicSearchMode,
    localMode,
    songsServerOffset,
    setLoading,
    setHasSearched,
    setGenreNote,
    setBasicSearchMode,
    setQuery,
    setActiveSearch,
    setSongsServerOffset,
    setSongsHasMore,
    setLocalMode,
    setResults,
    setLoadingMoreSongs,
  });

  useEffect(() => {
    return () => {
      const path = window.location.pathname;
      const leaving = consumeAdvancedSearchLeavingForDetail();
      const existingLeave = useAdvancedSearchSessionStore.getState().peekLeaveScrollSnapshot();
      if (isAdvancedSearchLeaveTargetPath(path) || leaving || existingLeave) {
        const snapshot = existingLeave ?? readAdvancedSearchLeaveSnapshot();
        useAdvancedSearchSessionStore.getState().setLeaveScrollSnapshot(snapshot);
        useAdvancedSearchSessionStore.getState().stashReturnSession({
          ...sessionRef.current,
          scrollTop: snapshot.scrollTop,
          albumRowScrollLeft: snapshot.albumRowScrollLeft,
          artistRowScrollLeft: snapshot.artistRowScrollLeft,
        });
      } else if (!isAdvancedSearchPath(path)) {
        useAdvancedSearchSessionStore.getState().clearReturnStash();
        clearAdvancedSearchLeaveSnapshots();
      }
    };
  }, []);

  useEffect(() => {
    if (shouldRestoreAdvancedSearchSession(navigationType, location.state)) {
      restoredFromStashRef.current = true;
      const stash = useAdvancedSearchSessionStore.getState().peekReturnStash();
      if (stash) {
        // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setQuery(stash.query);
        if (showTracksChrome) {
          const store = useLiveSearchScopeStore.getState();
          store.setScope('tracks');
          store.setQuery(stash.query);
        }
        setGenre(stash.genre);
        setYearFrom(stash.yearFrom);
        setYearTo(stash.yearTo);
        setBpmFrom(stash.bpmFrom);
        setBpmTo(stash.bpmTo);
        setMoodGroup(stash.moodGroup);
        setLosslessOnly(stash.losslessOnly);
        setResultType(stash.resultType);
        setStarredOnly(stash.starredOnly);
        setResults(stash.results);
        setHasSearched(stash.hasSearched);
        setActiveSearch(stash.activeSearch);
        setLocalMode(stash.localMode);
        setSongsServerOffset(stash.songsServerOffset);
        setSongsHasMore(stash.songsHasMore);
        setGenreNote(stash.genreNote);
        setBasicSearchMode(stash.basicSearchMode);
      }
      if (!leaveSnapshotRef.current) {
        useAdvancedSearchSessionStore.getState().clearReturnStash();
      }
      return;
    }
    if (restoredFromStashRef.current) return;
    useAdvancedSearchSessionStore.getState().clearReturnStash();
    // showTracksChrome is read inside the restore branch but must not retrigger
    // this navigation-driven stash restore; it is keyed on navigation only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationType, location.state]);

  const tracksSearchRestoreSynced =
    // React Compiler refs rule: ref used as a once-only init guard (checked before first assignment); not render data.
    // eslint-disable-next-line react-hooks/refs
    !tracksSearchRestorePendingRef.current
    || tracksSearchQuery.trim() === (songBrowseInitialRestore?.query.trim() ?? '');

  const leaveRestoreContentReady = showTracksChrome
    // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
    // eslint-disable-next-line react-hooks/refs
    ? tracksChromeLayoutReady
      // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
      // eslint-disable-next-line react-hooks/refs
      && tracksSearchRestoreSynced
      && (
        // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
        // eslint-disable-next-line react-hooks/refs
        (hadRestoreOnMountRef.current && songBrowseInitialRestore != null)
        || (songBrowse.hasSearched && !songBrowse.loading)
      )
    // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
    // eslint-disable-next-line react-hooks/refs
    : ((hadRestoreOnMountRef.current && results !== null) || (hasSearched && !loading));

  useLayoutEffect(() => {
    if (!leaveRestoreContentReady || leaveRestoreUiFinishedRef.current) return;
    if (showTracksChrome) return;
    const target = scrollTopRestoreTargetRef.current;
    if (target <= 0) {
      finishLeaveRestoreUi();
      return;
    }
    return restoreMainViewportScroll(target, finishLeaveRestoreUi);
  // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
  // eslint-disable-next-line react-hooks/refs
  }, [leaveRestoreContentReady, finishLeaveRestoreUi, showTracksChrome]);

  useEffect(() => {
    if (!showTracksChrome || leaveRestoreUiFinishedRef.current) return;
    if (!leaveRestoreContentReady) return;
    const target = scrollTopRestoreTargetRef.current;
    if (target <= 0) {
      finishLeaveRestoreUi();
      return;
    }
    if (songBrowse.songs.length === 0) return;
    return restoreMainViewportScroll(target, finishLeaveRestoreUi);
  }, [
    showTracksChrome,
    leaveRestoreContentReady,
    finishLeaveRestoreUi,
    songBrowse.songs.length,
    // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
    // eslint-disable-next-line react-hooks/refs
    tracksSearchRestoreSynced,
  ]);

  useEffect(() => {
    if (isLeaveRestorePending || !readAdvancedSearchRestore(location.state)) return;
    navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
  }, [isLeaveRestorePending, location.pathname, location.search, location.hash, location.state, navigate]);

  useEffect(() => {
    getGenres().then(data =>
      setGenres(data.sort((a, b) => a.value.localeCompare(b.value)))
    ).catch(() => {});
  }, []);

  useEffect(() => {
    if (hadRestoreOnMountRef.current) return;
    if (showTracksChrome) return;
    const q = qFromUrl.trim();
    if (!q) {
      if (!showAdvancedPanel) {
        // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setResults(null);
        setHasSearched(false);
      }
      return;
    }
    if (showAdvancedPanel) {
      runSearch({
        query: q,
        genre: '',
        yearFrom: '',
        yearTo: '',
        bpmFrom: '',
        bpmTo: '',
        moodGroup: '',
        losslessOnly: false,
        resultType: 'all',
      });
    } else {
      void runBasicSearch(q);
    }
    // runSearch / runBasicSearch are local helpers recreated each render; the
    // search is keyed on the query / panel / filter inputs, not their identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicLibraryFilterVersion, qFromUrl, showAdvancedPanel, showTracksChrome, serverId, indexEnabled]);

  const trackFilterActive =
    (MOOD_UI_ENABLED && !!moodGroup) || !!(bpmFrom || bpmTo);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const effectiveType = trackFilterActive ? 'songs' : resultType;
    runSearch({
      query,
      genre,
      yearFrom,
      yearTo,
      bpmFrom,
      bpmTo,
      moodGroup,
      losslessOnly,
      resultType: effectiveType,
    });
  };

  return (
    <div
      // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
      // eslint-disable-next-line react-hooks/refs
      className={`content-body${skipEnterAnimationRef.current ? '' : ' animate-fade-in'}${showTracksChrome ? ' tracks-page' : ''}`}
      style={{ position: 'relative' }}
      data-advanced-search-root
    >
      <div style={{ visibility: isLeaveRestorePending ? 'hidden' : 'visible' }}>
      <div className={showTracksChrome ? 'tracks-hub-stack' : undefined}>
      {showTracksChrome ? (
        <>
          <TracksPageChrome
            hideDiscoveryChrome={tracksDiscoveryHidden}
            onLayoutReady={
              isLeaveRestorePending && showTracksChrome ? handleTracksChromeLayoutReady : undefined
            }
          />
          {!perfFlags.disableMainstageVirtualLists && (
            <SongBrowseSection
              title={t('tracks.browseTitle')}
              emptyBrowseText={t('tracks.browseUnsupported')}
              searchActive={tracksSearchActive}
              songs={songBrowse.songs}
              hasMore={songBrowse.hasMore}
              loading={songBrowse.loading}
              browseUnsupported={songBrowse.browseUnsupported}
              onLoadMore={() => { void songBrowse.loadMore(); }}
            />
          )}
        </>
      ) : (
      <>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {showAdvancedPanel ? (
            <>
              <SlidersVertical size={22} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              {t('search.advanced')}
            </>
          ) : (
            <>
              <Search size={22} />
              {query.trim() ? t('search.resultsFor', { query }) : t('search.title')}
            </>
          )}
        </h1>
      </div>

      {showAdvancedPanel && (
        <AdvancedSearchFilterPanel
          query={query}
          setQuery={setQuery}
          genre={genre}
          setGenre={setGenre}
          genres={genres}
          yearFrom={yearFrom}
          setYearFrom={setYearFrom}
          yearTo={yearTo}
          setYearTo={setYearTo}
          bpmFrom={bpmFrom}
          setBpmFrom={setBpmFrom}
          bpmTo={bpmTo}
          setBpmTo={setBpmTo}
          moodGroup={moodGroup}
          setMoodGroup={setMoodGroup}
          losslessOnly={losslessOnly}
          setLosslessOnly={setLosslessOnly}
          resultType={resultType}
          setResultType={setResultType}
          starredOnly={starredOnly}
          setStarredOnly={setStarredOnly}
          trackFilterActive={trackFilterActive}
          indexEnabled={indexEnabled}
          loading={loading}
          // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
          // eslint-disable-next-line react-hooks/refs
          autoFocusQuery={!skipSearchAutoFocusRef.current}
          onSubmit={handleSubmit}
        />
      )}

      {/* ── Results ───────────────────────────────────────────── */}
      <AdvancedSearchResults
        showAdvancedPanel={showAdvancedPanel}
        hasSearched={hasSearched}
        loading={loading}
        basicSearchMode={basicSearchMode}
        query={query}
        filteredResults={filteredResults}
        activeSearch={activeSearch}
        genreNote={genreNote}
        songsHasMore={songsHasMore}
        loadingMoreSongs={loadingMoreSongs}
        loadMoreSongs={loadMoreSongs}
        artistRowScrollLeftRestoreRef={artistRowScrollLeftRestoreRef}
        artistRowScrollLeftRef={artistRowScrollLeftRef}
        albumRowScrollLeftRestoreRef={albumRowScrollLeftRestoreRef}
        albumRowScrollLeftRef={albumRowScrollLeftRef}
      />
      </>
      )}

      </div>
      </div>
      {isLeaveRestorePending && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div className="spinner" />
        </div>
      )}
    </div>
  );
}
