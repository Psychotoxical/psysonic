import { searchSongsPaged } from '../api/subsonicSearch';
import type { SubsonicSong } from '../api/subsonicTypes';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRefElementClientHeight } from '../hooks/useResizeClientHeight';
import { useVirtualizerScrollMargin } from '../hooks/useVirtualizerScrollMargin';
import { Search as SearchIcon, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
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
import SongRow, { SongListHeader } from './SongRow';

const PAGE_SIZE = 50;
const ROW_HEIGHT = 52;
const PREFETCH_PX = 600;

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

  const scrollParentRef = useRef<HTMLDivElement>(null);
  const scrollParentHeight = useRefElementClientHeight(scrollParentRef);
  const songListOverscan = Math.max(8, Math.ceil(scrollParentHeight / ROW_HEIGHT));
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
    if (scrollParentRef.current) scrollParentRef.current.scrollTop = 0;

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

  const loadMoreRef = useRef(loadMore);
  useEffect(() => { loadMoreRef.current = loadMore; }, [loadMore]);

  useEffect(() => {
    const el = scrollParentRef.current;
    if (!el) return;
    let rafId = 0;
    const onScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - PREFETCH_PX) {
          loadMoreRef.current();
        }
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  const virtualWrapRef = useRef<HTMLDivElement>(null);
  const scrollMargin = useVirtualizerScrollMargin(
    virtualWrapRef,
    () => scrollParentRef.current,
    { active: true, deps: [songs.length] },
  );

  const virtualizer = useVirtualizer({
    count: songs.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: songListOverscan,
    scrollMargin,
  });

  const totalSize = virtualizer.getTotalSize();
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
        <>
          <div ref={scrollParentRef} className="virtual-song-list-scroll">
            <SongListHeader />
            <div ref={virtualWrapRef} style={{ height: totalSize, width: '100%', position: 'relative' }}>
            {virtualizer.getVirtualItems().map(vi => {
              const song = songs[vi.index];
              if (!song) return null;
              return (
                <div
                  key={vi.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: ROW_HEIGHT,
                    transform: `translateY(${vi.start - scrollMargin}px)`,
                  }}
                >
                  <SongRow
                    song={song}
                  />
                </div>
              );
            })}
          </div>
            {loading && (
              <div className="virtual-song-list-loading">
                <div className="spinner" style={{ width: 18, height: 18 }} />
                <span>{t('common.loadingMore')}</span>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
