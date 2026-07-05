import { useRef, useCallback, type Dispatch, type SetStateAction } from 'react';
import { getAlbumsByGenre } from '@/lib/api/subsonicGenres';
import { search, searchSongsPaged } from '@/lib/api/subsonicSearch';
import { getRandomSongs } from '@/lib/api/subsonicLibrary';
import type { SubsonicArtist, SubsonicAlbum, SubsonicSong } from '@/lib/api/subsonicTypes';
import {
  loadMoreLocalSongs,
  runNetworkAdvancedTextSearch,
  runNetworkAdvancedYearAlbums,
  tryRunLocalAdvancedSearch,
} from '@/lib/library/advancedSearchLocal';
import { isLosslessSuffix } from '@/lib/library/losslessFormats';
import { OXIMEDIA_MOOD_SEARCH_ENABLED } from '@/lib/library/trackEnrichment';
import { raceSearchSources } from '@/lib/library/searchRace';
import { logLibrarySearch } from '@/lib/library/libraryDevLog';
import {
  browseRaceCountsFullSearch,
  loadMoreLocalBrowseSongs,
  raceBrowseWithLocalFallback,
  runLocalBrowseFullSearch,
  runNetworkBrowseFullSearch,
} from '@/lib/library/browseTextSearch';
import type { SearchOpts, Results } from '@/features/search/searchBrowseTypes';

const MOOD_UI_ENABLED = OXIMEDIA_MOOD_SEARCH_ENABLED;

// Pagination — basic quick search uses smaller pages than advanced form search.
const BASIC_SONGS_INITIAL = 50;
const BASIC_SONGS_PAGE_SIZE = 50;
const SONGS_INITIAL = 100;
const SONGS_PAGE_SIZE = 50;

function applySongFilters(
  list: SubsonicSong[],
  g: string,
  from: number | null,
  to: number | null,
  bpmLo: number | null,
  bpmHi: number | null,
  lossless = false,
): SubsonicSong[] {
  let r = list;
  if (g) r = r.filter(s => s.genre?.toLowerCase() === g.toLowerCase());
  if (from !== null) r = r.filter(s => !s.year || s.year >= from);
  if (to !== null) r = r.filter(s => !s.year || s.year <= to);
  if (bpmLo !== null) r = r.filter(s => s.bpm != null && s.bpm > 0 && s.bpm >= bpmLo);
  if (bpmHi !== null) r = r.filter(s => s.bpm != null && s.bpm > 0 && s.bpm <= bpmHi);
  if (lossless) r = r.filter(s => isLosslessSuffix(s.suffix));
  return r;
}

interface UseAdvancedSearchRunnerParams {
  serverId: string | null;
  indexEnabled: boolean;
  loadingMoreSongs: boolean;
  songsHasMore: boolean;
  activeSearch: SearchOpts | null;
  basicSearchMode: boolean;
  localMode: boolean;
  songsServerOffset: number;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setHasSearched: Dispatch<SetStateAction<boolean>>;
  setGenreNote: Dispatch<SetStateAction<boolean>>;
  setBasicSearchMode: Dispatch<SetStateAction<boolean>>;
  setQuery: Dispatch<SetStateAction<string>>;
  setActiveSearch: Dispatch<SetStateAction<SearchOpts | null>>;
  setSongsServerOffset: Dispatch<SetStateAction<number>>;
  setSongsHasMore: Dispatch<SetStateAction<boolean>>;
  setLocalMode: Dispatch<SetStateAction<boolean>>;
  setResults: Dispatch<SetStateAction<Results | null>>;
  setLoadingMoreSongs: Dispatch<SetStateAction<boolean>>;
}

/**
 * The search-execution engine for the search shell: basic quick search, advanced form
 * search (local-index/network race with filters + logging), and song pagination. Owns the
 * run-id staleness guard; the shell owns the result/filter state passed in via setters.
 */
export function useAdvancedSearchRunner({
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
}: UseAdvancedSearchRunnerParams) {
  const searchRunRef = useRef(0);

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
  }, [
    loadingMoreSongs, songsHasMore, activeSearch, songsServerOffset, localMode, serverId, basicSearchMode,
    setResults, setSongsServerOffset, setSongsHasMore, setLoadingMoreSongs,
  ]);

  return { runBasicSearch, runSearch, loadMoreSongs };
}
