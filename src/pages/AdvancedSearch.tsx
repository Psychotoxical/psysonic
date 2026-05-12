import { getGenres, getAlbumsByGenre } from '../api/subsonicGenres';
import { search, searchSongsPaged } from '../api/subsonicSearch';
import { getAlbumList, getRandomSongs } from '../api/subsonicLibrary';
import type { SubsonicGenre, SubsonicArtist, SubsonicAlbum, SubsonicSong } from '../api/subsonicTypes';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SlidersVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AlbumRow from '../components/AlbumRow';
import ArtistRow from '../components/ArtistRow';
import SongRow, { SongListHeader } from '../components/SongRow';
import CustomSelect from '../components/CustomSelect';
import StarFilterButton from '../components/StarFilterButton';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';

type ResultType = 'all' | 'artists' | 'albums' | 'songs';

interface SearchOpts {
  query: string;
  genre: string;
  yearFrom: string;
  yearTo: string;
  resultType: ResultType;
}

interface Results {
  artists: SubsonicArtist[];
  albums: SubsonicAlbum[];
  songs: SubsonicSong[];
}

export default function AdvancedSearch() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const qFromUrl = params.get('q') ?? '';
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [genre, setGenre] = useState('');
  const [yearFrom, setYearFrom] = useState('');
  const [yearTo, setYearTo] = useState('');
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
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

  // Pagination — only the free-text-query branch uses search3 with offset
  const SONGS_INITIAL = 100;
  const SONGS_PAGE_SIZE = 50;
  const [activeSearch, setActiveSearch] = useState<SearchOpts | null>(null);
  const [songsServerOffset, setSongsServerOffset] = useState(0);
  const [songsHasMore, setSongsHasMore] = useState(false);
  const [loadingMoreSongs, setLoadingMoreSongs] = useState(false);
  const songsSentinelRef = useRef<HTMLDivElement>(null);

  const applySongFilters = (
    list: SubsonicSong[],
    g: string,
    from: number | null,
    to: number | null,
  ): SubsonicSong[] => {
    let r = list;
    if (g) r = r.filter(s => s.genre?.toLowerCase() === g.toLowerCase());
    if (from !== null) r = r.filter(s => !s.year || s.year >= from);
    if (to !== null) r = r.filter(s => !s.year || s.year <= to);
    return r;
  };

  const runSearch = async (opts: SearchOpts) => {
    setLoading(true);
    setHasSearched(true);
    setGenreNote(false);
    setActiveSearch(opts);
    setSongsServerOffset(0);
    setSongsHasMore(false);
    const { query: q, genre: g, yearFrom: yf, yearTo: yt, resultType: rt } = opts;
    const from = yf ? parseInt(yf) : null;
    const to = yt ? parseInt(yt) : null;

    let artists: SubsonicArtist[] = [];
    let albums: SubsonicAlbum[] = [];
    let songs: SubsonicSong[] = [];

    try {
      if (q.trim()) {
        const r = await search(q.trim(), { artistCount: 30, albumCount: 50, songCount: SONGS_INITIAL });
        artists = r.artists;
        albums = r.albums;
        songs = applySongFilters(r.songs, g, from, to);

        if (g) {
          albums = albums.filter(a => a.genre?.toLowerCase() === g.toLowerCase());
        }
        if (from !== null) {
          albums = albums.filter(a => !a.year || a.year >= from);
        }
        if (to !== null) {
          albums = albums.filter(a => !a.year || a.year <= to);
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
        if (from !== null) albums = albums.filter(a => !a.year || a.year >= from);
        if (to !== null) albums = albums.filter(a => !a.year || a.year <= to);
        if (songs.length > 0) setGenreNote(true);
      } else if (from !== null || to !== null) {
        const fromYear = from ?? 1900;
        const toYear = to ?? new Date().getFullYear();
        albums = await getAlbumList('byYear', 100, 0, { fromYear, toYear });
      }

      setResults({
        artists: rt === 'albums' || rt === 'songs' ? [] : artists,
        albums: rt === 'artists' || rt === 'songs' ? [] : albums,
        songs: rt === 'artists' || rt === 'albums' ? [] : songs,
      });
    } catch {
      setResults({ artists: [], albums: [], songs: [] });
    }
    setLoading(false);
  };

  useEffect(() => {
    getGenres().then(data =>
      setGenres(data.sort((a, b) => a.value.localeCompare(b.value)))
    ).catch(() => {});
    if (qFromUrl) runSearch({ query: qFromUrl, genre: '', yearFrom: '', yearTo: '', resultType: 'all' });
  }, [musicLibraryFilterVersion, qFromUrl]);

  const loadMoreSongs = useCallback(async () => {
    if (loadingMoreSongs || !songsHasMore) return;
    if (!activeSearch || !activeSearch.query.trim()) return;
    setLoadingMoreSongs(true);
    try {
      const q = activeSearch.query.trim();
      const g = activeSearch.genre;
      const from = activeSearch.yearFrom ? parseInt(activeSearch.yearFrom) : null;
      const to = activeSearch.yearTo ? parseInt(activeSearch.yearTo) : null;
      const page = await searchSongsPaged(q, SONGS_PAGE_SIZE, songsServerOffset);
      const filtered = applySongFilters(page, g, from, to);
      setResults(prev => prev ? { ...prev, songs: [...prev.songs, ...filtered] } : prev);
      setSongsServerOffset(o => o + page.length);
      // No more pages when the server returned a non-full page (regardless of how many survived filtering).
      if (page.length < SONGS_PAGE_SIZE) setSongsHasMore(false);
    } catch {
      setSongsHasMore(false);
    } finally {
      setLoadingMoreSongs(false);
    }
  }, [loadingMoreSongs, songsHasMore, activeSearch, songsServerOffset]);

  // IntersectionObserver on the bottom sentinel — fires loadMoreSongs as it nears the viewport.
  useEffect(() => {
    const el = songsSentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) loadMoreSongs();
    }, { rootMargin: '600px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMoreSongs]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    runSearch({ query, genre, yearFrom, yearTo, resultType });
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

            {/* Row 3: Result type + Search button */}
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', alignItems: 'center' }}>
                {typeOptions.map(opt => (
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
            />
          )}

          {filteredResults && filteredResults.albums.length > 0 && (
            <AlbumRow
              title={`${t('search.albums')} (${filteredResults.albums.length})`}
              albums={filteredResults.albums}
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
              <SongListHeader />
              {filteredResults.songs.map(song => (
                <SongRow key={song.id} song={song} />
              ))}
              {songsHasMore && (
                <div ref={songsSentinelRef} style={{ display: 'flex', justifyContent: 'center', padding: '1rem' }}>
                  {loadingMoreSongs && <div className="spinner" style={{ width: 20, height: 20 }} />}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
