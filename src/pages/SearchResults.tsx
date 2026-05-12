import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { search, searchSongsPaged } from '../api/subsonic';
import type { SearchResults as ISearchResults } from '../api/subsonicTypes';
import AlbumRow from '../components/AlbumRow';
import ArtistRow from '../components/ArtistRow';
import SongRow, { SongListHeader } from '../components/SongRow';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';

const SONGS_INITIAL = 50;
const SONGS_PAGE_SIZE = 50;

export default function SearchResults() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const query = params.get('q') ?? '';
  const [results, setResults] = useState<ISearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [songsServerOffset, setSongsServerOffset] = useState(0);
  const [songsHasMore, setSongsHasMore] = useState(false);
  const [loadingMoreSongs, setLoadingMoreSongs] = useState(false);
  const songsSentinelRef = useRef<HTMLDivElement>(null);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

  useEffect(() => {
    setSongsServerOffset(0);
    setSongsHasMore(false);
    if (!query.trim()) { setResults(null); return; }
    setLoading(true);
    search(query, { artistCount: 20, albumCount: 20, songCount: SONGS_INITIAL })
      .then(r => {
        setResults(r);
        setSongsServerOffset(r.songs.length);
        setSongsHasMore(r.songs.length === SONGS_INITIAL);
      })
      .finally(() => setLoading(false));
  }, [query, musicLibraryFilterVersion]);

  const loadMoreSongs = useCallback(async () => {
    if (loadingMoreSongs || !songsHasMore || !query.trim()) return;
    setLoadingMoreSongs(true);
    try {
      const page = await searchSongsPaged(query.trim(), SONGS_PAGE_SIZE, songsServerOffset);
      setResults(prev => prev ? { ...prev, songs: [...prev.songs, ...page] } : prev);
      setSongsServerOffset(o => o + page.length);
      if (page.length < SONGS_PAGE_SIZE) setSongsHasMore(false);
    } catch {
      setSongsHasMore(false);
    } finally {
      setLoadingMoreSongs(false);
    }
  }, [loadingMoreSongs, songsHasMore, query, songsServerOffset]);

  useEffect(() => {
    const el = songsSentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) loadMoreSongs();
    }, { rootMargin: '600px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMoreSongs]);

  const hasResults = results && (results.artists.length || results.albums.length || results.songs.length);

  return (
    <div className="content-body animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>
      <div style={{ marginBottom: '-1.5rem' }}>
        <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <Search size={22} />
          {query ? t('search.resultsFor', { query }) : t('search.title')}
        </h1>
      </div>

      {loading && (
        <div className="loading-center"><div className="spinner" /></div>
      )}

      {!loading && query && !hasResults && (
        <div className="empty-state">{t('search.noResults', { query })}</div>
      )}

      {!loading && results && (
        <>
          {results.artists.length > 0 && (
            <ArtistRow title={t('search.artists')} artists={results.artists} />
          )}

          {results.albums.length > 0 && (
            <AlbumRow title={t('search.albums')} albums={results.albums} />
          )}

          {results.songs.length > 0 && (
            <section>
              <h2 className="section-title" style={{ marginBottom: '0.75rem' }}>{t('search.songs')}</h2>
              <SongListHeader />
              {results.songs.map(song => (
                <SongRow key={song.id} song={song} />
              ))}
              {songsHasMore && (
                <div ref={songsSentinelRef} style={{ display: 'flex', justifyContent: 'center', padding: '1rem' }}>
                  {loadingMoreSongs && <div className="spinner" style={{ width: 20, height: 20 }} />}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
