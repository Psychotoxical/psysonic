import { searchSongsPaged } from '../api/subsonicSearch';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import type { SearchResults as ISearchResults } from '../api/subsonicTypes';
import AlbumRow from '../components/AlbumRow';
import ArtistRow from '../components/ArtistRow';
import PagedSongList from '../components/PagedSongList';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import {
  browseRaceCountsFullSearch,
  loadMoreLocalBrowseSongs,
  raceBrowseWithLocalFallback,
  runLocalBrowseFullSearch,
  runNetworkBrowseFullSearch,
} from '../utils/library/browseTextSearch';

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
  const [localMode, setLocalMode] = useState(false);
  const searchRunRef = useRef(0);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const serverId = useAuthStore(s => s.activeServerId);
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));

  useEffect(() => {
    const q = query.trim();
    setSongsServerOffset(0);
    setSongsHasMore(false);
    setLocalMode(false);
    if (!q) {
      setResults(null);
      return;
    }

    const runId = ++searchRunRef.current;
    const isStale = () => runId !== searchRunRef.current;
    setLoading(true);

    void (async () => {
      try {
        if (serverId && indexEnabled) {
          const outcome = await raceBrowseWithLocalFallback(
            isStale,
            () => runLocalBrowseFullSearch(serverId, q, SONGS_INITIAL),
            () => runNetworkBrowseFullSearch(q, SONGS_INITIAL),
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
            setSongsHasMore(outcome.result.songs.length >= SONGS_INITIAL);
            setLocalMode(outcome.source === 'local');
            return;
          }
        }

        const network = await runNetworkBrowseFullSearch(q, SONGS_INITIAL);
        if (isStale()) return;
        if (network) {
          setResults(network);
          setSongsServerOffset(network.songs.length);
          setSongsHasMore(network.songs.length >= SONGS_INITIAL);
        } else {
          setResults({ artists: [], albums: [], songs: [] });
        }
      } catch {
        if (!isStale()) setResults(null);
      } finally {
        if (!isStale()) setLoading(false);
      }
    })();
  }, [query, musicLibraryFilterVersion, serverId, indexEnabled]);

  const loadMoreSongs = useCallback(async () => {
    const q = query.trim();
    if (loadingMoreSongs || !songsHasMore || !q) return;
    setLoadingMoreSongs(true);
    try {
      const page = localMode && serverId
        ? await loadMoreLocalBrowseSongs(serverId, q, songsServerOffset, SONGS_PAGE_SIZE)
        : await searchSongsPaged(q, SONGS_PAGE_SIZE, songsServerOffset);
      setResults(prev => prev ? { ...prev, songs: [...prev.songs, ...page] } : prev);
      setSongsServerOffset(o => o + page.length);
      if (page.length < SONGS_PAGE_SIZE) setSongsHasMore(false);
    } catch {
      setSongsHasMore(false);
    } finally {
      setLoadingMoreSongs(false);
    }
  }, [loadingMoreSongs, songsHasMore, query, songsServerOffset, localMode, serverId]);

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
              <PagedSongList
                songs={results.songs}
                hasMore={songsHasMore}
                loadingMore={loadingMoreSongs}
                onLoadMore={loadMoreSongs}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
