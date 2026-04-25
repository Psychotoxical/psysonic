import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Search as SearchIcon, X, ListPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SubsonicSong, searchSongsPaged } from '../api/subsonic';
import { ndListSongs } from '../api/navidromeBrowse';
import { usePlayerStore, songToTrack } from '../store/playerStore';
import { enqueueAndPlay } from '../utils/playSong';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const ROW_HEIGHT = 52;
const PREFETCH_PX = 600;

/**
 * Empty query → Navidrome /api/song sorted by title (no Subsonic equivalent).
 * Non-empty → Subsonic search3 (search isn't a browse).
 * Either way, returns a SubsonicSong[]; on Navidrome failure we fall back to search3.
 */
async function fetchSongPage(query: string, offset: number): Promise<SubsonicSong[]> {
  if (query !== '') {
    return searchSongsPaged(query, PAGE_SIZE, offset);
  }
  try {
    return await ndListSongs(offset, offset + PAGE_SIZE, 'title', 'ASC');
  } catch {
    return searchSongsPaged('', PAGE_SIZE, offset);
  }
}

function fmtDuration(s: number): string {
  if (!s || !isFinite(s)) return '–';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

interface RowProps {
  song: SubsonicSong;
  isCurrent: boolean;
}

const SongListRow = memo(function SongListRow({ song, isCurrent }: RowProps) {
  const navigate = useNavigate();
  const enqueue = usePlayerStore(s => s.enqueue);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);

  return (
    <div
      className={`virtual-song-row${isCurrent ? ' is-current' : ''}`}
      onDoubleClick={() => enqueueAndPlay(song)}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, song, 'song');
      }}
    >
      <div className="virtual-song-cell virtual-song-cell-actions-left">
        <button
          className="virtual-song-action-btn virtual-song-action-btn--play"
          onClick={(e) => { e.stopPropagation(); enqueueAndPlay(song); }}
          aria-label="Play"
        >
          <Play size={14} fill="currentColor" />
        </button>
        <button
          className="virtual-song-action-btn"
          onClick={(e) => { e.stopPropagation(); enqueue([songToTrack(song)]); }}
          aria-label="Enqueue"
        >
          <ListPlus size={14} />
        </button>
      </div>
      <div className="virtual-song-cell virtual-song-cell-title">
        <span className="virtual-song-title truncate">{song.title}</span>
        <span
          className={`virtual-song-artist truncate${song.artistId ? ' track-artist-link' : ''}`}
          onClick={(e) => {
            if (!song.artistId) return;
            e.stopPropagation();
            navigate(`/artist/${song.artistId}`);
          }}
        >{song.artist}</span>
      </div>
      <div className="virtual-song-cell virtual-song-cell-album truncate">
        {song.albumId ? (
          <span
            className="track-artist-link"
            onClick={(e) => { e.stopPropagation(); navigate(`/album/${song.albumId}`); }}
          >{song.album}</span>
        ) : <span>{song.album}</span>}
      </div>
      <div className="virtual-song-cell virtual-song-cell-duration">{fmtDuration(song.duration)}</div>
    </div>
  );
});

interface Props {
  title?: string;
  emptyBrowseText?: string;
}

export default function VirtualSongList({ title, emptyBrowseText }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [songs, setSongs] = useState<SubsonicSong[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [browseUnsupported, setBrowseUnsupported] = useState(false);

  const currentTrackId = usePlayerStore(s => s.currentTrack?.id ?? null);

  const scrollParentRef = useRef<HTMLDivElement>(null);
  const requestSeqRef = useRef(0);

  // Debounce query
  useEffect(() => {
    const h = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [query]);

  // Reset + first-page fetch on query change. One effect, no dep cascade,
  // and a `cancelled` flag so a fast typist doesn't see results from stale queries.
  useEffect(() => {
    let cancelled = false;
    setSongs([]);
    setOffset(0);
    setHasMore(true);
    setBrowseUnsupported(false);
    if (scrollParentRef.current) scrollParentRef.current.scrollTop = 0;

    const seq = ++requestSeqRef.current;
    setLoading(true);
    (async () => {
      try {
        const page = await fetchSongPage(debouncedQuery, 0);
        if (cancelled || seq !== requestSeqRef.current) return;
        if (page.length === 0) {
          setHasMore(false);
          if (debouncedQuery === '') setBrowseUnsupported(true);
        } else {
          setSongs(page);
          setOffset(page.length);
          if (page.length < PAGE_SIZE) setHasMore(false);
        }
      } catch {
        if (!cancelled) setHasMore(false);
      } finally {
        if (!cancelled && seq === requestSeqRef.current) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [debouncedQuery]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    const seq = ++requestSeqRef.current;
    try {
      const page = await fetchSongPage(debouncedQuery, offset);
      if (seq !== requestSeqRef.current) return;
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
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [loading, hasMore, debouncedQuery, offset]);

  // Scroll-based prefetch — uses ref so a stale loadMore can't loop
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

  const virtualizer = useVirtualizer({
    count: songs.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
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
        <div ref={scrollParentRef} className="virtual-song-list-scroll">
          <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
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
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <SongListRow
                    song={song}
                    isCurrent={currentTrackId === song.id}
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
      )}
    </section>
  );
}
