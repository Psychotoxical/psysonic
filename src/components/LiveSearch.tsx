import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Disc3, Users, Music, TextSearch, ListPlus, Link2 } from 'lucide-react';
import { search, SearchResults, buildCoverArtUrl, coverArtCacheKey, type SubsonicArtist } from '../api/subsonic';
import { usePlayerStore, songToTrack } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from 'react-i18next';
import CachedImage, { FETCH_QUEUE_BIAS_SEARCH_ARTIST_OVER_ALBUM } from './CachedImage';
import { showToast } from '../utils/toast';
import {
  activateShareSearchServer,
  enqueueShareSearchPayload,
} from '../utils/enqueueShareSearchPayload';
import { parseShareSearchText, sharePayloadTotal } from '../utils/shareSearch';
import { useShareSearchPreview } from '../hooks/useShareSearchPreview';

function debounce(fn: (q: string) => void, ms: number): (q: string) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (q: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(q), ms);
  };
}

function LiveSearchAlbumThumb({ coverArt }: { coverArt: string }) {
  const src = useMemo(() => buildCoverArtUrl(coverArt, 40), [coverArt]);
  const cacheKey = useMemo(() => coverArtCacheKey(coverArt, 40), [coverArt]);
  return <CachedImage className="search-result-thumb" src={src} cacheKey={cacheKey} alt="" />;
}

function LiveSearchArtistThumb({ artist }: { artist: Pick<SubsonicArtist, 'id' | 'coverArt'> }) {
  const [failed, setFailed] = useState(false);
  const coverId = artist.coverArt || artist.id;
  const src = useMemo(() => buildCoverArtUrl(coverId, 40), [coverId]);
  const cacheKey = useMemo(() => coverArtCacheKey(coverId, 40), [coverId]);
  useEffect(() => { setFailed(false); }, [coverId]);
  if (failed) return <div className="search-result-icon"><Users size={14} /></div>;
  return (
    <CachedImage
      className="search-result-thumb"
      src={src}
      cacheKey={cacheKey}
      alt=""
      loading="eager"
      fetchQueueBias={FETCH_QUEUE_BIAS_SEARCH_ARTIST_OVER_ALBUM}
      onError={() => setFailed(true)}
    />
  );
}

export default function LiveSearch() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isFocused, setIsFocused] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [shareQueueBusy, setShareQueueBusy] = useState(false);
  const navigate = useNavigate();
  const enqueue = usePlayerStore(state => state.enqueue);
  const openContextMenu = usePlayerStore(state => state.openContextMenu);
  const ctxIsOpen = usePlayerStore(state => state.contextMenu.isOpen);
  const ctxItemId = usePlayerStore(state => (state.contextMenu.item as { id?: string } | null)?.id);
  const ctxType   = usePlayerStore(state => state.contextMenu.type);
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const collapsedRef = useRef(false);
  const compactHeaderControlsRef = useRef(false);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const shareMatch = useMemo(() => parseShareSearchText(query), [query]);
  const {
    shareTrackSong,
    shareTrackResolving,
    shareTrackUnavailable,
    shareAlbum,
    shareAlbumResolving,
    shareAlbumUnavailable,
    shareArtist,
    shareArtistResolving,
    shareArtistUnavailable,
  } = useShareSearchPreview(shareMatch);

  const doSearch = useCallback(
    debounce(async (q: string) => {
      if (!q.trim()) { setResults(null); setOpen(false); return; }
      setLoading(true);
      try {
        const r = await search(q);
        setResults(r);
        setOpen(true);
      } finally {
        setLoading(false);
      }
    }, 300),
    [musicLibraryFilterVersion]
  );

  useEffect(() => {
    setActiveIndex(-1);
    if (shareMatch) {
      setResults(null);
      setLoading(false);
      setOpen(query.trim().length > 0);
      return;
    }
    doSearch(query);
  }, [query, doSearch, shareMatch]);

  const isSearchActive = isFocused || open || query.trim().length > 0;

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const header = root.closest('.content-header') as HTMLElement | null;
    if (!header) return;
    const overlayActive = isCollapsed && isSearchActive;
    if (overlayActive) {
      header.dataset.liveSearchOverlay = 'true';
    } else {
      delete header.dataset.liveSearchOverlay;
    }
    return () => {
      delete header.dataset.liveSearchOverlay;
    };
  }, [isCollapsed, isSearchActive]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const header = root.closest('.content-header') as HTMLElement | null;
    if (!header) return;
    const spacer = header.querySelector('.spacer') as HTMLElement | null;
    if (!spacer) return;

    const MIN_EXPANDED_WIDTH = 260;
    const SPACER_RESERVE = 24;
    const HYSTERESIS_PX = 20;
    // Live/Orbit compact-mode is intentionally stickier than search collapse,
    // otherwise both systems can feed each other and oscillate.
    const HEADER_CONTROLS_COMPACT_ON_SPACER = 36;
    const HEADER_CONTROLS_COMPACT_OFF_SPACER = 108;
    const SWITCH_COOLDOWN_MS = 180;
    const collapseThreshold = MIN_EXPANDED_WIDTH + SPACER_RESERVE;
    const expandThreshold = collapseThreshold + HYSTERESIS_PX;
    let lastSwitchAt = 0;
    let cooldownTimer: number | null = null;

    const updateCollapsed = () => {
      const searchWidth = root.getBoundingClientRect().width;
      const spacerWidth = spacer.getBoundingClientRect().width;
      const budget = searchWidth + spacerWidth;
      const headerOverflowing = header.scrollWidth - header.clientWidth > 1;
      let nextCollapsed = collapsedRef.current
        ? budget < expandThreshold
        : budget < collapseThreshold;
      // Priority rule: if we are already compacting Live/Orbit labels, search
      // must stay collapsed until compact mode can be released.
      if (compactHeaderControlsRef.current) {
        nextCollapsed = true;
      }
      if (nextCollapsed !== collapsedRef.current) {
        const now = performance.now();
        const remaining = SWITCH_COOLDOWN_MS - (now - lastSwitchAt);
        if (remaining > 0) {
          if (cooldownTimer == null) {
            cooldownTimer = window.setTimeout(() => {
              cooldownTimer = null;
              updateCollapsed();
            }, remaining);
          }
          return;
        }
        lastSwitchAt = now;
        collapsedRef.current = nextCollapsed;
        setIsCollapsed(nextCollapsed);
      }

      const nextCompactControls = nextCollapsed
        ? (
          compactHeaderControlsRef.current
            // Stay compact until we clearly have room and no overflow.
            ? (headerOverflowing || spacerWidth < HEADER_CONTROLS_COMPACT_OFF_SPACER)
            // Enter compact only when both tight spacer and real overflow exist.
            : (headerOverflowing && spacerWidth < HEADER_CONTROLS_COMPACT_ON_SPACER)
        )
        : false;
      if (nextCompactControls !== compactHeaderControlsRef.current) {
        compactHeaderControlsRef.current = nextCompactControls;
        if (nextCompactControls) {
          header.dataset.liveHeaderCompact = 'true';
        } else {
          delete header.dataset.liveHeaderCompact;
        }
      }
    };

    updateCollapsed();
    const ro = new ResizeObserver(updateCollapsed);
    ro.observe(header);
    ro.observe(spacer);
    ro.observe(root);
    window.addEventListener('resize', updateCollapsed);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateCollapsed);
      delete header.dataset.liveHeaderCompact;
      if (cooldownTimer != null) {
        window.clearTimeout(cooldownTimer);
      }
    };
  }, []);

  // Close on click outside — but stay open while a song context menu is up.
  // The CM renders a fullscreen transparent backdrop (z-index 998) above the
  // dropdown, so any mousedown — including a second right-click on another
  // row — would otherwise hit the backdrop and trip this handler, yanking the
  // dropdown closed mid-interaction.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ctxIsOpen) return;
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ctxIsOpen]);

  const hasResults = shareMatch || (results && (results.artists.length || results.albums.length || results.songs.length));
  const canQueueShareMatch = shareMatch?.type === 'queueable'
    && (shareMatch.payload.k === 'queue' || (!!shareTrackSong && !shareTrackResolving));
  const canOpenShareAlbum = shareMatch?.type === 'album' && !!shareAlbum && !shareAlbumResolving;
  const canOpenShareArtist = shareMatch?.type === 'artist' && !!shareArtist && !shareArtistResolving;

  const openShareAlbum = useCallback(() => {
    if (shareMatch?.type !== 'album' || !shareAlbum) return;
    if (!activateShareSearchServer(shareMatch.payload.srv, t)) return;
    navigate(`/album/${shareAlbum.id}`);
    setOpen(false);
    setQuery('');
  }, [navigate, shareAlbum, shareMatch, t]);

  const openShareArtist = useCallback(() => {
    if (shareMatch?.type !== 'artist' || !shareArtist) return;
    if (!activateShareSearchServer(shareMatch.payload.srv, t)) return;
    navigate(`/artist/${shareArtist.id}`);
    setOpen(false);
    setQuery('');
  }, [navigate, shareArtist, shareMatch, t]);

  const enqueueShareMatch = useCallback(async () => {
    if (shareMatch?.type !== 'queueable' || shareQueueBusy) return;
    if (shareMatch.payload.k === 'track' && (!shareTrackSong || shareTrackResolving)) return;
    setShareQueueBusy(true);
    const ok = await enqueueShareSearchPayload(shareMatch.payload, t);
    setShareQueueBusy(false);
    if (ok) {
      setOpen(false);
      setQuery('');
    }
  }, [shareMatch, shareQueueBusy, shareTrackResolving, shareTrackSong, t]);

  // Flat list of all navigable items for keyboard nav
  const flatItems = canQueueShareMatch ? [
    { id: 'share-link', action: () => { void enqueueShareMatch(); } },
  ] : canOpenShareAlbum ? [
    { id: 'share-album', action: openShareAlbum },
  ] : canOpenShareArtist ? [
    { id: 'share-artist', action: openShareArtist },
  ] : results ? [
    ...(results.artists.map(a => ({ id: a.id, action: () => { navigate(`/artist/${a.id}`); setOpen(false); setQuery(''); } }))),
    ...(results.albums.map(a => ({ id: a.id, action: () => { navigate(`/album/${a.id}`); setOpen(false); setQuery(''); } }))),
   ...(results.songs.map(s => ({ id: s.id, action: () => {
       const track = songToTrack(s);
       enqueue([track]);
       showToast(t('search.addedToQueueToast', { title: track.title }), 2200, 'info');
       setOpen(false); setQuery('');
     }}))),
  ] : [];

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (shareMatch) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (canQueueShareMatch) void enqueueShareMatch();
        else if (canOpenShareAlbum) openShareAlbum();
        else if (canOpenShareArtist) openShareArtist();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex(canQueueShareMatch || canOpenShareAlbum || canOpenShareArtist ? 0 : -1);
      } else if (e.key === 'Escape') {
        setOpen(false);
        setActiveIndex(-1);
      }
      return;
    }
    if (!open || !flatItems.length) {
      if (e.key === 'Enter' && query.trim()) { setOpen(false); navigate(`/search?q=${encodeURIComponent(query.trim())}`); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(activeIndex + 1, flatItems.length - 1);
      setActiveIndex(next);
      dropdownRef.current?.querySelectorAll<HTMLElement>('.search-result-item')[next]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(activeIndex - 1, -1);
      setActiveIndex(next);
      if (next >= 0) dropdownRef.current?.querySelectorAll<HTMLElement>('.search-result-item')[next]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0) { flatItems[activeIndex].action(); setActiveIndex(-1); }
      else if (query.trim()) { setOpen(false); navigate(`/search?q=${encodeURIComponent(query.trim())}`); }
    } else if (e.key === 'Escape') {
      setOpen(false); setActiveIndex(-1);
    }
  };

  return (
    <div
      className="live-search"
      ref={ref}
      role="search"
      data-collapsed={isCollapsed || undefined}
      data-active={isSearchActive || undefined}
    >
      <div
        className="live-search-input-wrap"
        onMouseDown={(e) => {
          if (isSearchActive) return;
          if (!isCollapsed) return;
          e.preventDefault();
          setIsFocused(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
      >
        {loading ? (
          <span className="live-search-icon animate-spin" style={{ opacity: 0.6 }}>
            <div style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%' }} />
          </span>
        ) : (
          <Search size={16} className="live-search-icon" />
        )}
        <input
          ref={inputRef}
          id="live-search-input"
          className="input live-search-field"
          type="search"
          placeholder={t('search.placeholder')}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => {
            setIsFocused(true);
            if (results || shareMatch) setOpen(true);
          }}
          onBlur={() => setIsFocused(false)}
          onKeyDown={handleKeyDown}
          aria-autocomplete="list"
          aria-controls="search-results"
          aria-expanded={open}
          autoComplete="off"
        />
        {query && (
          <button className="live-search-clear" onClick={() => { setQuery(''); setResults(null); setOpen(false); }} aria-label={t('search.clearLabel')}>
            ×
          </button>
        )}
        <button
          className="live-search-adv-btn"
          type="button"
          onMouseDown={(e) => {
            // Keep focus on the search input so collapsed-overlay controls
            // remain active long enough for this button click to fire.
            e.preventDefault();
          }}
          onClick={() => navigate(query.trim() ? `/search/advanced?q=${encodeURIComponent(query.trim())}` : '/search/advanced')}
          data-tooltip={t('search.advanced')}
          data-tooltip-pos="bottom"
          aria-label={t('search.advanced')}
        >
          <TextSearch size={14} />
        </button>
      </div>

      {open && (
        <div className="live-search-dropdown" id="search-results" role="listbox" ref={dropdownRef}>
          {!hasResults && !loading && (
            <div className="search-empty">{t('search.noResults', { query })}</div>
          )}

          {shareMatch && (
            <div className="search-section">
              <div className="search-section-label"><Link2 size={12} /> {t('search.shareLink')}</div>
              {shareMatch.type === 'artist' ? (
                shareArtistResolving ? (
                  <div className="search-result-item search-result-item--muted">
                    <div className="search-result-icon"><Users size={14} /></div>
                    <div>
                      <div className="search-result-name">{t('common.loading')}</div>
                      <div className="search-result-sub">{t('search.artists')}</div>
                    </div>
                  </div>
                ) : shareArtist ? (
                  <button
                    className={`search-result-item${activeIndex === 0 ? ' active' : ''}`}
                    onClick={openShareArtist}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (shareMatch?.type !== 'artist' || !activateShareSearchServer(shareMatch.payload.srv, t)) return;
                      openContextMenu(e.clientX, e.clientY, shareArtist, 'artist');
                    }}
                    role="option"
                    aria-selected={activeIndex === 0}
                  >
                    <LiveSearchArtistThumb artist={shareArtist} />
                    <div>
                      <div className="search-result-name">{shareArtist.name}</div>
                    </div>
                  </button>
                ) : (
                  <div className="search-result-item search-result-item--muted">
                    <div className="search-result-icon"><Link2 size={14} /></div>
                    <div>
                      <div className="search-result-name">
                        {shareArtistUnavailable ? t('sharePaste.artistUnavailable') : t('sharePaste.genericError')}
                      </div>
                      <div className="search-result-sub">{t('search.shareUnsupportedSub')}</div>
                    </div>
                  </div>
                )
              ) : shareMatch.type === 'album' ? (
                shareAlbumResolving ? (
                  <div className="search-result-item search-result-item--muted">
                    <div className="search-result-icon"><Disc3 size={14} /></div>
                    <div>
                      <div className="search-result-name">{t('common.loading')}</div>
                      <div className="search-result-sub">{t('search.album')}</div>
                    </div>
                  </div>
                ) : shareAlbum ? (
                  <button
                    className={`search-result-item${activeIndex === 0 ? ' active' : ''}`}
                    onClick={openShareAlbum}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (shareMatch?.type !== 'album' || !activateShareSearchServer(shareMatch.payload.srv, t)) return;
                      openContextMenu(e.clientX, e.clientY, shareAlbum, 'album');
                    }}
                    role="option"
                    aria-selected={activeIndex === 0}
                  >
                    {shareAlbum.coverArt ? (
                      <LiveSearchAlbumThumb coverArt={shareAlbum.coverArt} />
                    ) : (
                      <div className="search-result-icon"><Disc3 size={14} /></div>
                    )}
                    <div>
                      <div className="search-result-name">{shareAlbum.name}</div>
                      <div className="search-result-sub">{shareAlbum.artist}</div>
                    </div>
                  </button>
                ) : (
                  <div className="search-result-item search-result-item--muted">
                    <div className="search-result-icon"><Link2 size={14} /></div>
                    <div>
                      <div className="search-result-name">
                        {shareAlbumUnavailable ? t('sharePaste.albumUnavailable') : t('sharePaste.genericError')}
                      </div>
                      <div className="search-result-sub">{t('search.shareUnsupportedSub')}</div>
                    </div>
                  </div>
                )
              ) : shareMatch.type === 'queueable' && shareMatch.payload.k === 'track' ? (
                shareTrackResolving ? (
                  <div className="search-result-item search-result-item--muted">
                    <div className="search-result-icon"><Music size={14} /></div>
                    <div>
                      <div className="search-result-name">{t('common.loading')}</div>
                      <div className="search-result-sub">{t('search.shareTrackTitle')}</div>
                    </div>
                  </div>
                ) : shareTrackSong ? (
                  <button
                    className={`search-result-item${activeIndex === 0 ? ' active' : ''}`}
                    onClick={() => void enqueueShareMatch()}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (shareMatch?.type !== 'queueable' || !activateShareSearchServer(shareMatch.payload.srv, t)) return;
                      openContextMenu(e.clientX, e.clientY, songToTrack(shareTrackSong), 'song');
                    }}
                    disabled={shareQueueBusy}
                    role="option"
                    aria-selected={activeIndex === 0}
                  >
                    {shareTrackSong.coverArt ? (
                      <LiveSearchAlbumThumb coverArt={shareTrackSong.coverArt} />
                    ) : (
                      <div className="search-result-icon"><Music size={14} /></div>
                    )}
                    <div>
                      <div className="search-result-name">{shareTrackSong.title}</div>
                      <div className="search-result-sub">
                        {shareQueueBusy
                          ? t('search.shareQueueing')
                          : `${shareTrackSong.artist}${shareTrackSong.album ? ` · ${shareTrackSong.album}` : ''}`}
                      </div>
                    </div>
                  </button>
                ) : (
                  <div className="search-result-item search-result-item--muted">
                    <div className="search-result-icon"><Link2 size={14} /></div>
                    <div>
                      <div className="search-result-name">
                        {shareTrackUnavailable ? t('sharePaste.trackUnavailable') : t('sharePaste.genericError')}
                      </div>
                      <div className="search-result-sub">{t('search.shareUnsupportedSub')}</div>
                    </div>
                  </div>
                )
              ) : shareMatch.type === 'queueable' ? (
                <button
                  className={`search-result-item${activeIndex === 0 ? ' active' : ''}`}
                  onClick={() => void enqueueShareMatch()}
                  disabled={shareQueueBusy}
                  role="option"
                  aria-selected={activeIndex === 0}
                >
                  <div className="search-result-icon"><ListPlus size={14} /></div>
                  <div>
                    <div className="search-result-name">
                      {shareMatch.payload.k === 'track'
                        ? t('search.shareTrackTitle')
                        : t('search.shareQueueTitle', { count: sharePayloadTotal(shareMatch.payload) })}
                    </div>
                    <div className="search-result-sub">
                      {shareQueueBusy ? t('search.shareQueueing') : t('search.shareQueueAction')}
                    </div>
                  </div>
                </button>
              ) : (
                <div className="search-result-item search-result-item--muted">
                  <div className="search-result-icon"><Link2 size={14} /></div>
                  <div>
                    <div className="search-result-name">{t('search.shareUnsupportedTitle')}</div>
                    <div className="search-result-sub">{t('search.shareUnsupportedSub')}</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {(() => {
            if (shareMatch) return null;
            let idx = 0;
            return <>
              {results?.artists.length ? (
                <div className="search-section">
                  <div className="search-section-label"><Users size={12} /> {t('search.artists')}</div>
                  {results.artists.map(a => {
                    const i = idx++;
                    const isCtxActive = ctxIsOpen && ctxType === 'artist' && ctxItemId === a.id;
                    return (
                      <button key={a.id} className={`search-result-item${activeIndex === i ? ' active' : ''}${isCtxActive ? ' context-active' : ''}`}
                        onClick={() => { navigate(`/artist/${a.id}`); setOpen(false); setQuery(''); }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          openContextMenu(e.clientX, e.clientY, a, 'artist');
                        }}
                        role="option" aria-selected={activeIndex === i}>
                        <LiveSearchArtistThumb artist={a} />
                        <div>
                          <div className="search-result-name">{a.name}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {results?.albums.length ? (
                <div className="search-section">
                  <div className="search-section-label"><Disc3 size={12} /> {t('search.albums')}</div>
                  {results.albums.map(a => {
                    const i = idx++;
                    const isCtxActive = ctxIsOpen && ctxType === 'album' && ctxItemId === a.id;
                    return (
                      <button key={a.id} className={`search-result-item${activeIndex === i ? ' active' : ''}${isCtxActive ? ' context-active' : ''}`}
                        onClick={() => { navigate(`/album/${a.id}`); setOpen(false); setQuery(''); }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          openContextMenu(e.clientX, e.clientY, a, 'album');
                        }}
                        role="option" aria-selected={activeIndex === i}>
                        {a.coverArt ? (
                          <LiveSearchAlbumThumb coverArt={a.coverArt} />
                        ) : (
                          <div className="search-result-icon"><Disc3 size={14} /></div>
                        )}
                        <div>
                          <div className="search-result-name">{a.name}</div>
                          <div className="search-result-sub">{a.artist}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {results?.songs.length ? (
                <div className="search-section">
                  <div className="search-section-label"><Music size={12} /> {t('search.songs')}</div>
                  {results.songs.map(s => {
                    const i = idx++;
                    const isCtxActive = ctxIsOpen && ctxType === 'song' && ctxItemId === s.id;
                    return (
                      <button key={s.id} className={`search-result-item${activeIndex === i ? ' active' : ''}${isCtxActive ? ' context-active' : ''}`}
                        onClick={() => {
                          const track = songToTrack(s);
                          enqueue([track]);
                          showToast(t('search.addedToQueueToast', { title: track.title }), 2200, 'info');
                          setOpen(false); setQuery('');
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          // Keep the dropdown open — context menu portal renders above it,
                          // and closing here would yank the list out from under the user.
                          openContextMenu(e.clientX, e.clientY, songToTrack(s), 'song');
                        }}
                        role="option" aria-selected={activeIndex === i}>
                        <div className="search-result-icon"><Music size={14} /></div>
                        <div>
                          <div className="search-result-name">{s.title}</div>
                          <div className="search-result-sub">{s.artist} · {s.album}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </>;
          })()}
        </div>
      )}
    </div>
  );
}
