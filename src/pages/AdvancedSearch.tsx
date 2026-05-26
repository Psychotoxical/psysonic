import { getGenres, getAlbumsByGenre } from '../api/subsonicGenres';
import { search, searchSongsPaged } from '../api/subsonicSearch';
import { getAlbumList, getRandomSongs } from '../api/subsonicLibrary';
import type { SubsonicGenre, SubsonicArtist, SubsonicAlbum, SubsonicSong } from '../api/subsonicTypes';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SlidersVertical, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AlbumRow from '../components/AlbumRow';
import ArtistRow from '../components/ArtistRow';
import PagedSongList from '../components/PagedSongList';
import CustomSelect from '../components/CustomSelect';
import StarFilterButton from '../components/StarFilterButton';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import { runLocalAdvancedSearch, loadMoreLocalSongs, runNetworkAdvancedTextSearch } from '../utils/library/advancedSearchLocal';
import { isLosslessSuffix } from '../utils/library/losslessFormats';
import { LOSSLESS_MODE_QUERY } from '../utils/library/losslessMode';
import { OXIMEDIA_MOOD_SEARCH_ENABLED } from '../utils/library/trackEnrichment';
import { raceSearchSources } from '../utils/library/searchRace';
import { logLibrarySearch } from '../utils/library/libraryDevLog';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import { MOOD_GROUP_IDS } from '../config/moodGroups';

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

export default function AdvancedSearch() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const qFromUrl = params.get('q') ?? '';
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [genre, setGenre] = useState('');
  const [yearFrom, setYearFrom] = useState('');
  const [yearTo, setYearTo] = useState('');
  const [bpmFrom, setBpmFrom] = useState('');
  const [bpmTo, setBpmTo] = useState('');
  const [moodGroup, setMoodGroup] = useState('');
  const [losslessOnly, setLosslessOnly] = useState(false);
  const [resultType, setResultType] = useState<ResultType>('all');
  const [starredOnly, setStarredOnly] = useState(false);
  const [genres, setGenres] = useState<SubsonicGenre[]>([]);
  const [results, setResults] = useState<Results | null>(null);
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
  const [hasSearched, setHasSearched] = useState(false);
  const [genreNote, setGenreNote] = useState(false);
  // True while the current results came from the local index (drives the
  // pagination branch — local pages every result type, network only free-text).
  const [localMode, setLocalMode] = useState(false);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const serverId = useAuthStore(s => s.activeServerId);
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));
  const searchRunRef = useRef(0);

  // Pagination — only the free-text-query branch uses search3 with offset
  const SONGS_INITIAL = 100;
  const SONGS_PAGE_SIZE = 50;
  const [activeSearch, setActiveSearch] = useState<SearchOpts | null>(null);
  const [songsServerOffset, setSongsServerOffset] = useState(0);
  const [songsHasMore, setSongsHasMore] = useState(false);
  const [loadingMoreSongs, setLoadingMoreSongs] = useState(false);

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

  const runSearch = async (opts: SearchOpts) => {
    const runId = ++searchRunRef.current;
    const isStale = () => runId !== searchRunRef.current;

    setLoading(true);
    setHasSearched(true);
    setGenreNote(false);
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
              run: () =>
                runLocalAdvancedSearch(serverId, opts, SONGS_INITIAL, false, true, true),
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
      const localPage = await runLocalAdvancedSearch(serverId, opts, SONGS_INITIAL);
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
        const fromYear = from ?? 1900;
        const toYear = to ?? new Date().getFullYear();
        albums = await getAlbumList('byYear', 100, 0, { fromYear, toYear });
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
    getGenres().then(data =>
      setGenres(data.sort((a, b) => a.value.localeCompare(b.value)))
    ).catch(() => {});
    if (qFromUrl) {
      runSearch({
        query: qFromUrl,
        genre: '',
        yearFrom: '',
        yearTo: '',
        bpmFrom: '',
        bpmTo: '',
        moodGroup: '',
        losslessOnly: false,
        resultType: 'all',
      });
    }
  }, [musicLibraryFilterVersion, qFromUrl]);

  const loadMoreSongs = useCallback(async () => {
    if (loadingMoreSongs || !songsHasMore || !activeSearch) return;

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
  }, [loadingMoreSongs, songsHasMore, activeSearch, songsServerOffset, localMode, serverId]);

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

  const typeOptions: { id: ResultType; label: string }[] = [
    { id: 'all',     label: t('search.advancedAll') },
    { id: 'artists', label: t('search.artists') },
    { id: 'albums',  label: t('search.albums') },
    { id: 'songs',   label: t('search.songs') },
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
    <div className="content-body animate-fade-in">
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <SlidersVertical size={22} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          {t('search.advanced')}
        </h1>
      </div>

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
                autoFocus
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
                {!trackFilterActive && typeOptions.map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`btn ${resultType === opt.id ? 'btn-primary' : 'btn-surface'}`}
                    style={{ fontSize: 12, padding: '4px 14px' }}
                    onClick={() => setResultType(opt.id)}
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

      {/* ── Results ───────────────────────────────────────────── */}
      {!hasSearched ? (
        <div className="empty-state" style={{ opacity: 0.6 }}>
          {t('search.advancedEmpty')}
        </div>
      ) : loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <div className="spinner" />
        </div>
      ) : total === 0 ? (
        <div className="empty-state">{t('search.advancedNoResults')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>

          {filteredResults && filteredResults.artists.length > 0 && (
            <ArtistRow
              title={`${t('search.artists')} (${filteredResults.artists.length})`}
              artists={filteredResults.artists}
              artistLinkQuery={activeSearch?.losslessOnly ? LOSSLESS_MODE_QUERY : undefined}
            />
          )}

          {filteredResults && filteredResults.albums.length > 0 && (
            <AlbumRow
              title={`${t('search.albums')} (${filteredResults.albums.length})`}
              albums={filteredResults.albums}
              albumLinkQuery={activeSearch?.losslessOnly ? LOSSLESS_MODE_QUERY : undefined}
            />
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
    </div>
  );
}
