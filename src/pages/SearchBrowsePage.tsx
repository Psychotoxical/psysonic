import { getGenres, getAlbumsByGenre } from '../api/subsonicGenres';
import { search, searchSongsPaged } from '../api/subsonicSearch';
import { getRandomSongs } from '../api/subsonicLibrary';
import type { SubsonicGenre, SubsonicArtist, SubsonicAlbum, SubsonicSong } from '../api/subsonicTypes';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom';
import { SlidersVertical, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AlbumRow from '../components/AlbumRow';
import ArtistRow from '../components/ArtistRow';
import PagedSongList from '../components/PagedSongList';
import CustomSelect from '../components/CustomSelect';
import StarFilterButton from '../components/StarFilterButton';
import { tooltipAttrs } from '../components/tooltipAttrs';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import { isAdvancedSearchLeaveTargetPath } from '../store/albumBrowseSessionStore';
import {
  isAdvancedSearchPath,
  isAdvancedSearchPanelPath,
  isTracksBrowsePath,
  useAdvancedSearchSessionStore,
  type AdvancedSearchSessionStash,
} from '../store/advancedSearchSessionStore';
import {
  readAdvancedSearchRestore,
  shouldRestoreAdvancedSearchSession,
} from '../utils/navigation/albumDetailNavigation';
import {
  clearAdvancedSearchLeaveSnapshots,
  consumeAdvancedSearchLeavingForDetail,
  readAdvancedSearchLeaveSnapshot,
  registerAdvancedSearchLeaveScrollProvider,
  registerAdvancedSearchSessionProvider,
  resolveAdvancedSearchLeaveSnapshot,
  type AdvancedSearchLeaveSnapshot,
} from '../utils/navigation/advancedSearchScrollSnapshot';
import { restoreMainViewportScroll } from '../utils/navigation/restoreMainViewportScroll';
import {
  loadMoreLocalSongs,
  runNetworkAdvancedTextSearch,
  runNetworkAdvancedYearAlbums,
  tryRunLocalAdvancedSearch,
} from '../utils/library/advancedSearchLocal';
import { isLosslessSuffix } from '../utils/library/losslessFormats';
import { LOSSLESS_MODE_QUERY } from '../utils/library/losslessMode';
import { OXIMEDIA_MOOD_SEARCH_ENABLED } from '../utils/library/trackEnrichment';
import { raceSearchSources } from '../utils/library/searchRace';
import { logLibrarySearch } from '../utils/library/libraryDevLog';
import {
  browseRaceCountsFullSearch,
  loadMoreLocalBrowseSongs,
  raceBrowseWithLocalFallback,
  runLocalBrowseFullSearch,
  runNetworkBrowseFullSearch,
} from '../utils/library/browseTextSearch';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import { MOOD_GROUP_IDS } from '../config/moodGroups';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { useSongBrowseList, type SongBrowseListRestore } from '../hooks/useSongBrowseList';
import TracksPageChrome from '../components/tracks/TracksPageChrome';
import SongBrowseSection from '../components/tracks/SongBrowseSection';
import {
  useLiveSearchScopeStore,
  useScopedBrowseSearchQuery,
} from '../store/liveSearchScopeStore';

const MOOD_UI_ENABLED = OXIMEDIA_MOOD_SEARCH_ENABLED;

type ResultType = 'all' | 'artists' | 'albums' | 'songs';

interface SearchOpts {
  query: string;
  genre: string;
  yearFrom: string;
  yearTo: string;
  bpmFrom: string;
  bpmTo: string;
  moodGroup: string;
  losslessOnly: boolean;
  resultType: ResultType;
}

interface Results {
  artists: SubsonicArtist[];
  albums: SubsonicAlbum[];
  songs: SubsonicSong[];
}

function parseBpmInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

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
  const total = filteredResults
    ? filteredResults.artists.length + filteredResults.albums.length + filteredResults.songs.length
    : 0;
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
  const searchRunRef = useRef(0);

  // Pagination — basic quick search uses smaller pages than advanced form search.
  const BASIC_SONGS_INITIAL = 50;
  const BASIC_SONGS_PAGE_SIZE = 50;
  const SONGS_INITIAL = 100;
  const SONGS_PAGE_SIZE = 50;
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

  const applySongFilters = (
    list: SubsonicSong[],
    g: string,
    from: number | null,
    to: number | null,
    bpmLo: number | null,
    bpmHi: number | null,
    lossless = false,
  ): SubsonicSong[] => {
    let r = list;
    if (g) r = r.filter(s => s.genre?.toLowerCase() === g.toLowerCase());
    if (from !== null) r = r.filter(s => !s.year || s.year >= from);
    if (to !== null) r = r.filter(s => !s.year || s.year <= to);
    if (bpmLo !== null) r = r.filter(s => s.bpm != null && s.bpm > 0 && s.bpm >= bpmLo);
    if (bpmHi !== null) r = r.filter(s => s.bpm != null && s.bpm > 0 && s.bpm <= bpmHi);
    if (lossless) r = r.filter(s => isLosslessSuffix(s.suffix));
    return r;
  };

  const runBasicSearch = async (rawQuery: string) => {
    const q = rawQuery.trim();
    const runId = ++searchRunRef.current;
    const isStale = () => runId !== searchRunRef.current;

    setLoading(true);
    setHasSearched(true);
    setGenreNote(false);
    setBasicSearchMode(true);
    setQuery(q);
    setActiveSearch({
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
    setSongsServerOffset(0);
    setSongsHasMore(false);
    setLocalMode(false);

    if (!q) {
      setResults(null);
      setLoading(false);
      return;
    }

    try {
      if (serverId && indexEnabled) {
        const outcome = await raceBrowseWithLocalFallback(
          isStale,
          () => runLocalBrowseFullSearch(serverId, q, BASIC_SONGS_INITIAL),
          () => runNetworkBrowseFullSearch(q, BASIC_SONGS_INITIAL),
          {
            surface: 'search_results',
            query: q,
            indexEnabled,
            counts: browseRaceCountsFullSearch,
          },
        );
        if (isStale()) return;
        if (outcome) {
          setResults(outcome.result);
          setSongsServerOffset(outcome.result.songs.length);
          setSongsHasMore(outcome.result.songs.length >= BASIC_SONGS_INITIAL);
          setLocalMode(outcome.source === 'local');
          return;
        }
      }

      const network = await runNetworkBrowseFullSearch(q, BASIC_SONGS_INITIAL);
      if (isStale()) return;
      if (network) {
        setResults(network);
        setSongsServerOffset(network.songs.length);
        setSongsHasMore(network.songs.length >= BASIC_SONGS_INITIAL);
      } else {
        setResults({ artists: [], albums: [], songs: [] });
      }
    } catch {
      if (!isStale()) setResults(null);
    } finally {
      if (!isStale()) setLoading(false);
    }
  };

  const runSearch = async (opts: SearchOpts) => {
    const runId = ++searchRunRef.current;
    const isStale = () => runId !== searchRunRef.current;

    setLoading(true);
    setHasSearched(true);
    setGenreNote(false);
    setBasicSearchMode(false);
    setActiveSearch(opts);
    setSongsServerOffset(0);
    setSongsHasMore(false);
    const q = opts.query.trim();
    const searchT0 = performance.now();
    const moodFilterActive = MOOD_UI_ENABLED && !!opts.moodGroup;
    const bpmFilterActive = !!(opts.bpmFrom || opts.bpmTo);
    const losslessFilterActive = opts.losslessOnly;
    const trackOnlyFilterActive = moodFilterActive || bpmFilterActive;

    // Track-only filters (BPM dual-storage, mood) need the local index for full coverage.
    // Lossless skips the race — network search3 cannot filter albums by format reliably.
    if (q && serverId && indexEnabled && !trackOnlyFilterActive && !losslessFilterActive) {
      try {
        const winner = await raceSearchSources(
          [
            {
              source: 'local',
              run: () => tryRunLocalAdvancedSearch(serverId, opts, SONGS_INITIAL, true),
            },
            {
              source: 'network',
              run: () => runNetworkAdvancedTextSearch(opts, SONGS_INITIAL),
            },
          ],
          isStale,
        );
        if (isStale()) return;
        if (winner) {
          setResults({
            artists: winner.result.artists,
            albums: winner.result.albums,
            songs: winner.result.songs,
          });
          setSongsServerOffset(winner.result.songs.length);
          setSongsHasMore(winner.result.songs.length >= SONGS_INITIAL);
          setLocalMode(winner.source === 'local');
          logLibrarySearch({
            at: new Date().toISOString(),
            query: q,
            path: 'search_race',
            surface: 'advanced_search',
            durationMs: Math.round(performance.now() - searchT0),
            indexEnabled,
            raceWinner: winner.source,
            raceWinnerMs: winner.durationMs,
            counts: {
              artists: winner.result.artists.length,
              albums: winner.result.albums.length,
              songs: winner.result.songs.length,
            },
          });
          setLoading(false);
          return;
        }
      } catch {
        if (isStale()) return;
      }
      setLocalMode(false);
    } else if (serverId && indexEnabled) {
      const localPage = await tryRunLocalAdvancedSearch(serverId, opts, SONGS_INITIAL);
      if (isStale()) return;
      if (localPage) {
        setResults({
          artists: localPage.artists,
          albums: localPage.albums,
          songs: localPage.songs,
        });
        setSongsServerOffset(localPage.songs.length);
        setSongsHasMore(localPage.songs.length >= SONGS_INITIAL);
        setLocalMode(true);
        setLoading(false);
        return;
      }
      if (trackOnlyFilterActive) {
        setResults({ artists: [], albums: [], songs: [] });
        setLoading(false);
        return;
      }
      setLocalMode(false);
    } else {
      setLocalMode(false);
    }

    if ((trackOnlyFilterActive || losslessFilterActive) && !indexEnabled) {
      setResults({ artists: [], albums: [], songs: [] });
      setLoading(false);
      return;
    }

    const { genre: g, yearFrom: yf, yearTo: yt, bpmFrom: bf, bpmTo: bt, losslessOnly: lossless, resultType: rt } = opts;
    const from = yf ? parseInt(yf) : null;
    const to = yt ? parseInt(yt) : null;
    const bpmLo = bf ? parseInt(bf) : null;
    const bpmHi = bt ? parseInt(bt) : null;

    let artists: SubsonicArtist[] = [];
    let albums: SubsonicAlbum[] = [];
    let songs: SubsonicSong[] = [];

    try {
      if (q.trim()) {
        const r = await search(q.trim(), { artistCount: 30, albumCount: 50, songCount: SONGS_INITIAL });
        artists = r.artists;
        albums = r.albums;
        songs = applySongFilters(r.songs, g, from, to, bpmLo, bpmHi, lossless);

        if (g) {
          albums = albums.filter(a => a.genre?.toLowerCase() === g.toLowerCase());
        }
        if (from !== null) {
          albums = albums.filter(a => !a.year || a.year >= from);
        }
        if (to !== null) {
          albums = albums.filter(a => !a.year || a.year <= to);
        }
        if (lossless) {
          const albumIds = new Set(songs.map(s => s.albumId).filter(Boolean));
          albums = albums.filter(a => albumIds.has(a.id));
          const artistIds = new Set(songs.map(s => s.artistId).filter(Boolean));
          artists = artists.filter(a => artistIds.has(a.id));
        }

        // Only the free-text branch supports server-side pagination via search3 offset.
        // If the server returned a full page, more probably exist.
        setSongsServerOffset(r.songs.length);
        setSongsHasMore(r.songs.length === SONGS_INITIAL);
      } else if (g) {
        const [albumRes, songRes] = await Promise.all([
          rt === 'songs' || rt === 'artists' ? Promise.resolve([]) : getAlbumsByGenre(g, 50),
          rt === 'albums' || rt === 'artists' ? Promise.resolve([]) : getRandomSongs(100, g),
        ]);
        albums = albumRes as SubsonicAlbum[];
        songs = songRes as SubsonicSong[];
        songs = applySongFilters(songs, g, from, to, bpmLo, bpmHi, lossless);
        if (from !== null) albums = albums.filter(a => !a.year || a.year >= from);
        if (to !== null) albums = albums.filter(a => !a.year || a.year <= to);
        if (songs.length > 0) setGenreNote(true);
      } else if (from !== null || to !== null) {
        if (rt !== 'artists' && rt !== 'songs') {
          albums = await runNetworkAdvancedYearAlbums(opts, 100);
        }
      }

      const finalResults = {
        artists: rt === 'albums' || rt === 'songs' ? [] : artists,
        albums: rt === 'artists' || rt === 'songs' ? [] : albums,
        songs: rt === 'artists' || rt === 'albums' ? [] : songs,
      };
      setResults(finalResults);
      if (q.trim()) {
        logLibrarySearch({
          at: new Date().toISOString(),
          query: q,
          path: 'search3',
          surface: 'advanced_search',
          source: 'network',
          durationMs: Math.round(performance.now() - searchT0),
          indexEnabled,
          counts: {
            artists: finalResults.artists.length,
            albums: finalResults.albums.length,
            songs: finalResults.songs.length,
          },
        });
      }
    } catch {
      setResults({ artists: [], albums: [], songs: [] });
    }
    setLoading(false);
  };

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

  const loadMoreSongs = useCallback(async () => {
    if (loadingMoreSongs || !songsHasMore || !activeSearch) return;

    if (basicSearchMode) {
      const q = activeSearch.query.trim();
      if (!q) return;
      setLoadingMoreSongs(true);
      try {
        const page = localMode && serverId
          ? await loadMoreLocalBrowseSongs(serverId, q, songsServerOffset, BASIC_SONGS_PAGE_SIZE)
          : await searchSongsPaged(q, BASIC_SONGS_PAGE_SIZE, songsServerOffset);
        setResults(prev => prev ? { ...prev, songs: [...prev.songs, ...page] } : prev);
        setSongsServerOffset(o => o + page.length);
        if (page.length < BASIC_SONGS_PAGE_SIZE) setSongsHasMore(false);
      } catch {
        setSongsHasMore(false);
      } finally {
        setLoadingMoreSongs(false);
      }
      return;
    }

    // Local mode pages every result type (genre/year too), not just free-text.
    if (localMode) {
      if (!serverId) return;
      setLoadingMoreSongs(true);
      try {
        const more = await loadMoreLocalSongs(serverId, activeSearch, songsServerOffset, SONGS_PAGE_SIZE);
        setResults(prev => (prev ? { ...prev, songs: [...prev.songs, ...more] } : prev));
        setSongsServerOffset(o => o + more.length);
        if (more.length < SONGS_PAGE_SIZE) setSongsHasMore(false);
      } catch {
        setSongsHasMore(false);
      } finally {
        setLoadingMoreSongs(false);
      }
      return;
    }

    if (!activeSearch.query.trim()) return;
    setLoadingMoreSongs(true);
    try {
      const q = activeSearch.query.trim();
      const g = activeSearch.genre;
      const from = activeSearch.yearFrom ? parseInt(activeSearch.yearFrom) : null;
      const to = activeSearch.yearTo ? parseInt(activeSearch.yearTo) : null;
      const bpmLo = activeSearch.bpmFrom ? parseInt(activeSearch.bpmFrom) : null;
      const bpmHi = activeSearch.bpmTo ? parseInt(activeSearch.bpmTo) : null;
      const page = await searchSongsPaged(q, SONGS_PAGE_SIZE, songsServerOffset);
      const filtered = applySongFilters(
        page,
        g,
        from,
        to,
        bpmLo,
        bpmHi,
        activeSearch.losslessOnly,
      );
      setResults(prev => prev ? { ...prev, songs: [...prev.songs, ...filtered] } : prev);
      setSongsServerOffset(o => o + page.length);
      // No more pages when the server returned a non-full page (regardless of how many survived filtering).
      if (page.length < SONGS_PAGE_SIZE) setSongsHasMore(false);
    } catch {
      setSongsHasMore(false);
    } finally {
      setLoadingMoreSongs(false);
    }
  }, [loadingMoreSongs, songsHasMore, activeSearch, songsServerOffset, localMode, serverId, basicSearchMode]);

  const trackFilterActive =
    (MOOD_UI_ENABLED && !!moodGroup) || !!(bpmFrom || bpmTo);

  const bpmFilterDraftActive = !!(bpmFrom || bpmTo);

  const clearBpmFilter = () => {
    setBpmFrom('');
    setBpmTo('');
  };

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

  const typeOptions: { id: ResultType; label: string; tooltip: string }[] = [
    { id: 'all',     label: t('search.advancedAll'), tooltip: t('search.scopeAllTooltip') },
    { id: 'artists', label: t('search.artists'),     tooltip: t('search.scopeArtistsChipTooltip') },
    { id: 'albums',  label: t('search.albums'),      tooltip: t('search.scopeAlbumsChipTooltip') },
    { id: 'songs',   label: t('search.songs'),       tooltip: t('search.scopeSongsChipTooltip') },
  ];

  const genreSelectOptions = [
    { value: '', label: t('search.advancedAllGenres') },
    ...genres.map(g => ({ value: g.value, label: g.value })),
  ];

  const moodSelectOptions = useMemo(
    () => [
      { value: '', label: t('search.advancedAllMoods') },
      ...MOOD_GROUP_IDS.map(id => ({
        value: id,
        label: t(`search.moodGroups.${id}`),
      })),
    ],
    [t],
  );

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
      <>
      {/* ── Filter panel ──────────────────────────────────────── */}
      <form onSubmit={handleSubmit}>
        <div className="settings-card" style={{ padding: '1.25rem', marginBottom: '2rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>

            {/* Row 1: Search term */}
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 90, flexShrink: 0 }}>
                {t('search.advancedSearchTerm')}
              </span>
              <input
                className="input"
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('search.advancedSearchPlaceholder')}
                style={{ flex: 1 }}
                // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
                // eslint-disable-next-line react-hooks/refs
                autoFocus={!skipSearchAutoFocusRef.current}
              />
            </div>

            {/* Row 2: Genre + Year */}
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 90, flexShrink: 0 }}>
                {t('search.advancedGenre')}
              </span>
              <div style={{ minWidth: 240, flex: '1 1 240px', maxWidth: 360 }}>
                <CustomSelect
                  value={genre}
                  options={genreSelectOptions}
                  onChange={setGenre}
                />
              </div>

              <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: '0.75rem', flexShrink: 0 }}>
                {t('search.advancedYear')}
              </span>
              <input
                className="input"
                type="number"
                min={1900}
                max={new Date().getFullYear()}
                value={yearFrom}
                onChange={e => setYearFrom(e.target.value)}
                placeholder={t('search.advancedYearFrom')}
                style={{ width: 96 }}
              />
              <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>–</span>
              <input
                className="input"
                type="number"
                min={1900}
                max={new Date().getFullYear()}
                value={yearTo}
                onChange={e => setYearTo(e.target.value)}
                placeholder={t('search.advancedYearTo')}
                style={{ width: 96 }}
              />
            </div>

            {/* Row 3: BPM (tag + measured enrichment) */}
            {indexEnabled && (
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 90, flexShrink: 0 }}>
                  {t('search.advancedBpm')}
                </span>
                <input
                  className="input"
                  type="number"
                  min={20}
                  max={999}
                  value={bpmFrom}
                  onChange={e => setBpmFrom(e.target.value)}
                  onBlur={e => {
                    const from = parseBpmInput(e.target.value);
                    const to = parseBpmInput(bpmTo);
                    if (from != null && to != null && from > to) setBpmTo('');
                  }}
                  placeholder={t('search.advancedYearFrom')}
                  style={{ width: 96 }}
                />
                <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>–</span>
                <input
                  className="input"
                  type="number"
                  min={20}
                  max={999}
                  value={bpmTo}
                  onChange={e => setBpmTo(e.target.value)}
                  onBlur={e => {
                    const to = parseBpmInput(e.target.value);
                    const from = parseBpmInput(bpmFrom);
                    if (from != null && to != null && to < from) setBpmFrom('');
                  }}
                  placeholder={t('search.advancedYearTo')}
                  style={{ width: 96 }}
                />
                {bpmFilterDraftActive && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={clearBpmFilter}
                    style={{
                      padding: '0.3rem 0.55rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                      fontSize: '0.8rem',
                      flexShrink: 0,
                    }}
                  >
                    <X size={13} />
                    {t('search.advancedBpmClear')}
                  </button>
                )}
              </div>
            )}

            {/* Lossless — suffix allowlist (FLAC, WAV, …) */}
            {indexEnabled && (
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 90, flexShrink: 0 }}>
                  {t('search.advancedLossless')}
                </span>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.45rem',
                    fontSize: 13,
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={losslessOnly}
                    onChange={e => setLosslessOnly(e.target.checked)}
                  />
                  {t('search.advancedLosslessOnly')}
                </label>
              </div>
            )}

            {/* Mood — hidden while oximedia mood analysis is disabled */}
            {indexEnabled && MOOD_UI_ENABLED && (
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 90, flexShrink: 0 }}>
                  {t('search.advancedMoodGroup')}
                </span>
                <div style={{ minWidth: 240, flex: '1 1 240px', maxWidth: 360 }}>
                  <CustomSelect
                    value={moodGroup}
                    options={moodSelectOptions}
                    onChange={setMoodGroup}
                  />
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('search.advancedMoodLocalNote')}
                </span>
              </div>
            )}

            {/* Row 4: Result type + Search button */}
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', alignItems: 'center' }}>
                {!trackFilterActive && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: '0.15rem' }}>
                    {t('search.scopeRowLabel')}
                  </span>
                )}
                {!trackFilterActive && typeOptions.map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`btn ${resultType === opt.id ? 'btn-primary' : 'btn-surface'}`}
                    style={{ fontSize: 12, padding: '4px 14px' }}
                    onClick={() => setResultType(opt.id)}
                    {...tooltipAttrs(opt.tooltip)}
                  >
                    {opt.label}
                  </button>
                ))}
                <StarFilterButton size="small" active={starredOnly} onChange={setStarredOnly} />
              </div>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={loading}
                style={{ minWidth: 100 }}
              >
                {loading
                  ? <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                  : t('search.advancedSearch')
                }
              </button>
            </div>
          </div>
        </div>
      </form>
      </>
      )}

      {/* ── Results ───────────────────────────────────────────── */}
      {showAdvancedPanel && !hasSearched ? (
        <div className="empty-state" style={{ opacity: 0.6 }}>
          {t('search.advancedEmpty')}
        </div>
      ) : loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <div className="spinner" />
        </div>
      ) : total === 0 ? (
        <div className="empty-state">
          {basicSearchMode && query.trim()
            ? t('search.noResults', { query })
            : t('search.advancedNoResults')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>

          {filteredResults && filteredResults.artists.length > 0 && (
            <div data-advanced-search-artist-row>
            <ArtistRow
              title={
                basicSearchMode
                  ? t('search.artists')
                  : `${t('search.artists')} (${filteredResults.artists.length})`
              }
              artists={filteredResults.artists}
              artistLinkQuery={activeSearch?.losslessOnly ? LOSSLESS_MODE_QUERY : undefined}
              restoreScrollLeft={
                // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
                // eslint-disable-next-line react-hooks/refs
                artistRowScrollLeftRestoreRef.current > 0
                  // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
                  // eslint-disable-next-line react-hooks/refs
                  ? artistRowScrollLeftRestoreRef.current
                  : undefined
              }
              onScrollLeftSnapshot={(left) => {
                artistRowScrollLeftRef.current = left;
              }}
            />
            </div>
          )}

          {filteredResults && filteredResults.albums.length > 0 && (
            <div data-advanced-search-album-row>
            <AlbumRow
              title={
                basicSearchMode
                  ? t('search.albums')
                  : `${t('search.albums')} (${filteredResults.albums.length})`
              }
              albums={filteredResults.albums}
              albumLinkQuery={activeSearch?.losslessOnly ? LOSSLESS_MODE_QUERY : undefined}
              windowArtworkByViewport
              initialArtworkBudget={12}
              restoreScrollLeft={
                // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
                // eslint-disable-next-line react-hooks/refs
                albumRowScrollLeftRestoreRef.current > 0
                  // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
                  // eslint-disable-next-line react-hooks/refs
                  ? albumRowScrollLeftRestoreRef.current
                  : undefined
              }
              onScrollLeftSnapshot={(left) => {
                albumRowScrollLeftRef.current = left;
              }}
            />
            </div>
          )}

          {filteredResults && filteredResults.songs.length > 0 && (
            <section>
              <h2 className="section-title" style={{ marginBottom: '0.75rem' }}>
                {t('search.songs')}
                {genreNote && (
                  <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: '0.75rem' }}>
                    — {t('search.advancedGenreNote')}
                  </span>
                )}
              </h2>
              <PagedSongList
                songs={filteredResults.songs}
                hasMore={songsHasMore}
                loadingMore={loadingMoreSongs}
                onLoadMore={loadMoreSongs}
                showBpm={!!(activeSearch?.bpmFrom || activeSearch?.bpmTo)}
              />
            </section>
          )}
        </div>
      )}
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
