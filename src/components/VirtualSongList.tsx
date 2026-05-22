import { searchSongsPaged } from '../api/subsonicSearch';
import type { SubsonicSong } from '../api/subsonicTypes';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Search as SearchIcon, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
import PagedSongList from './PagedSongList';

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

interface Props {
  title?: string;
  emptyBrowseText?: string;
}

/**
 * Browse-all-tracks list. Renders through the shared `PagedSongList` in the page
 * flow (sticky header + plain rows + sentinel paging), so it matches the Search
 * pages and the column header can't be painted over while scrolling (issue #841).
 */
export default function VirtualSongList({ title, emptyBrowseText }: Props) {
  const { t } = useTranslation();
  const serverId = useAuthStore(s => s.activeServerId);
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [songs, setSongs] = useState<SubsonicSong[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [browseUnsupported, setBrowseUnsupported] = useState(false);

  const requestSeqRef = useRef(0);
  const localSearchModeRef = useRef(false);

  useEffect(() => {
    const debounceMs = indexEnabled ? BROWSE_TEXT_DEBOUNCE_RACE_MS : BROWSE_TEXT_DEBOUNCE_NETWORK_MS;
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), debounceMs);
    return () => window.clearTimeout(timer);
  }, [query, indexEnabled]);

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
      } catch {
        if (!isStale()) setHasMore(false);
      } finally {
        if (!isStale()) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, fetchSongPage]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
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
  }, [loading, hasMore, debouncedQuery, offset, fetchSongPage]);

  const showEmptyBrowse = !loading && songs.length === 0 && debouncedQuery === '' && (browseUnsupported || !hasMore);

  return (
    <section className="virtual-song-list-section">
      {title && <h2 className="section-title virtual-song-list-title">{title}</h2>}
      <div className="virtual-song-list-toolbar">
        <div className="virtual-song-list-search">
          <SearchIcon size={16} className="virtual-song-list-search-icon" />
          <input
            type="text"
            className="input virtual-song-list-search-input"
            placeholder={t('tracks.searchPlaceholder')}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && (
            <button
              className="virtual-song-list-search-clear"
              onClick={() => setQuery('')}
              aria-label={t('search.clearLabel')}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="virtual-song-list-meta">
          {songs.length > 0 && (
            <span>{t('tracks.count', { count: songs.length })}{hasMore ? '+' : ''}</span>
          )}
        </div>
      </div>

      {showEmptyBrowse ? (
        <div className="virtual-song-list-empty">
          {emptyBrowseText ?? t('tracks.browseUnsupported')}
        </div>
      ) : (
        <PagedSongList
          songs={songs}
          hasMore={hasMore}
          loadingMore={loading}
          onLoadMore={loadMore}
        />
      )}
    </section>
  );
}
