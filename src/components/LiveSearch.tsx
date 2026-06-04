import { subscribeLibrarySyncIdle, subscribeLibrarySyncProgress } from '../api/library';
import type { SearchResults, SubsonicArtist } from '../api/subsonicTypes';
import { songToTrack } from '../utils/playback/songToTrack';
import {
  LIVE_SEARCH_DEBOUNCE_NETWORK_MS,
  LIVE_SEARCH_DEBOUNCE_RACE_MS,
  EMPTY_SEARCH_RESULTS,
  liveSearchQueryRejected,
  mergeLiveSearchResults,
  runLocalLiveSearch,
  runNetworkLiveSearch,
} from '../utils/library/liveSearchLocal';
import { raceLiveSearch } from '../utils/library/searchRace';
import { libraryIsReady } from '../utils/library/libraryReady';
import {
  emitLiveSearchDebug,
  searchHitCounts,
  searchResultSamples,
} from '../utils/library/liveSearchDebug';
import {
  logLibrarySearch,
} from '../utils/library/libraryDevLog';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useNavigateToAlbum } from '../hooks/useNavigateToAlbum';
import { Search, Disc3, Users, Music, TextSearch, Database, Globe } from 'lucide-react';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import { useTranslation } from 'react-i18next';
import { FETCH_QUEUE_BIAS_SEARCH_ARTIST_OVER_ALBUM } from './CachedImage';
import type { SubsonicSong } from '../api/subsonicTypes';
import { AlbumCoverArtImage } from '../cover/AlbumCoverArtImage';
import { ArtistCoverArtImage } from '../cover/ArtistCoverArtImage';
import { CoverArtImage } from '../cover/CoverArtImage';
import { COVER_DENSE_SEARCH_CSS_PX } from '../cover/layoutSizes';
import { albumCoverRefForSong } from '../cover/ref';
import { showToast } from '../utils/ui/toast';
import { useShareSearch } from '../hooks/useShareSearch';
import ShareSearchResults from './search/ShareSearchResults';
import {
  LiveSearchScopeBadge,
  LiveSearchScopeGhostBadge,
  createLiveSearchScopeBackspaceState,
  handleLiveSearchScopeBackspace,
  handleLiveSearchScopeUndo,
  isLiveSearchDropdownBlocked,
  liveSearchScopePlaceholderKey,
  noteLiveSearchScopeQueryInput,
  resetLiveSearchScopeBackspaceState,
  resolveLiveSearchScopeGhost,
} from './search/liveSearchScopeUi';
import { useLiveSearchScopeStore } from '../store/liveSearchScopeStore';
import { resolveIndexKey } from '../utils/server/serverIndexKey';

type LiveSearchSource = 'local' | 'network';

function LiveSearchAlbumThumb({ albumId, coverArt }: { albumId: string; coverArt: string }) {
  return (
    <AlbumCoverArtImage
      albumId={albumId}
      coverArt={coverArt}
      libraryResolve={false}
      displayCssPx={COVER_DENSE_SEARCH_CSS_PX}
      surface="dense"
      className="search-result-thumb"
      alt=""
      ensurePriority="high"
    />
  );
}

function LiveSearchSongThumb({ song }: { song: Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber'> }) {
  const coverRef = React.useMemo(
    () => (song.albumId?.trim() ? albumCoverRefForSong(song) : undefined),
    [song.id, song.albumId, song.coverArt, song.discNumber],
  );
  if (!coverRef) return null;
  return (
    <CoverArtImage
      coverRef={coverRef}
      displayCssPx={COVER_DENSE_SEARCH_CSS_PX}
      surface="dense"
      className="search-result-thumb"
      alt=""
      ensurePriority="high"
    />
  );
}

function LiveSearchArtistThumb({ artist }: { artist: Pick<SubsonicArtist, 'id' | 'coverArt'> }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [artist.id, artist.coverArt]);
  if (failed) return <div className="search-result-icon"><Users size={14} /></div>;
  return (
    <ArtistCoverArtImage
      artistId={artist.id}
      coverArt={artist.coverArt}
      libraryResolve={false}
      displayCssPx={COVER_DENSE_SEARCH_CSS_PX}
      surface="dense"
      className="search-result-thumb"
      alt=""
      loading="eager"
      ensurePriority="high"
      fetchQueueBias={FETCH_QUEUE_BIAS_SEARCH_ARTIST_OVER_ALBUM}
      onError={() => setFailed(true)}
    />
  );
}

export default function LiveSearch() {
  const { t } = useTranslation();
  const query = useLiveSearchScopeStore(s => s.query);
  const setQuery = useLiveSearchScopeStore(s => s.setQuery);
  const scope = useLiveSearchScopeStore(s => s.scope);
  const setScope = useLiveSearchScopeStore(s => s.setScope);
  const clearScope = useLiveSearchScopeStore(s => s.clearScope);
  const undoLiveSearch = useLiveSearchScopeStore(s => s.undo);
  const scopeBackspaceRef = useRef(createLiveSearchScopeBackspaceState());
  const location = useLocation();
  const ghostScope = resolveLiveSearchScopeGhost(location.pathname, scope);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isFocused, setIsFocused] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [searchSource, setSearchSource] = useState<LiveSearchSource | null>(null);
  const localReadyRef = useRef(false);
  const liveSearchGenRef = useRef(0);
  const navigate = useNavigate();
  const navigateToAlbum = useNavigateToAlbum();
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
  const serverId = useAuthStore(s => s.activeServerId);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));

  const refreshLocalReady = useCallback(async () => {
    if (!serverId || !indexEnabled) {
      localReadyRef.current = false;
      return;
    }
    localReadyRef.current = await libraryIsReady(serverId);
  }, [serverId, indexEnabled]);

  useEffect(() => {
    void refreshLocalReady();
  }, [refreshLocalReady, musicLibraryFilterVersion]);

  useEffect(() => {
    resetLiveSearchScopeBackspaceState(scopeBackspaceRef.current);
  }, [scope]);

  useEffect(() => {
    noteLiveSearchScopeQueryInput(scopeBackspaceRef.current, query);
  }, [query]);

  useEffect(() => {
    if (!indexEnabled || !serverId) return;
    let unlistenProgress: (() => void) | undefined;
    let unlistenIdle: (() => void) | undefined;
    const indexKey = resolveIndexKey(serverId);
    void subscribeLibrarySyncIdle(payload => {
      if (payload.serverId === indexKey) void refreshLocalReady();
    }).then(fn => {
      unlistenIdle = fn;
    });
    void subscribeLibrarySyncProgress(p => {
      if (p.serverId === indexKey && p.kind === 'phase_changed') void refreshLocalReady();
    }).then(fn => {
      unlistenProgress = fn;
    });
    return () => {
      unlistenIdle?.();
      unlistenProgress?.();
    };
  }, [indexEnabled, serverId, refreshLocalReady]);

  const closeSearch = useCallback(() => {
    setOpen(false);
    setQuery('');
    setSearchSource(null);
  }, [setQuery]);

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value, { recordUndo: true });
    if (!value) {
      setResults(null);
      setOpen(false);
      setSearchSource(null);
    }
  }, [setQuery]);

  /** Leave live search for a full-page route — cancel in-flight queries and reset overlay state. */
  const leaveLiveSearchFor = useCallback((path: string) => {
    liveSearchGenRef.current += 1;
    setOpen(false);
    setQuery('');
    setResults(null);
    setSearchSource(null);
    setActiveIndex(-1);
    setLoading(false);
    setIsFocused(false);
    inputRef.current?.blur();
    navigate(path);
  }, [navigate, setQuery]);

  const share = useShareSearch(query, closeSearch);

  useEffect(() => {
    if (isLiveSearchDropdownBlocked(scope)) {
      setResults(null);
      setOpen(false);
      setSearchSource(null);
      setLoading(false);
      return;
    }

    if (share.shareMatch) {
      setResults(null);
      setLoading(false);
      setSearchSource(null);
      setOpen(true);
      setActiveIndex(-1);
      return;
    }

    const q = query.trim();
    if (!q) {
      setResults(null);
      setOpen(false);
      setSearchSource(null);
      setLoading(false);
      return;
    }

    setSearchSource(null);
    setActiveIndex(-1);

    const abort = new AbortController();
    const debounceMs = indexEnabled ? LIVE_SEARCH_DEBOUNCE_RACE_MS : LIVE_SEARCH_DEBOUNCE_NETWORK_MS;

    const timer = window.setTimeout(() => {
      void (async () => {
        const gen = liveSearchGenRef.current;
        const isStale = () =>
          gen !== liveSearchGenRef.current || abort.signal.aborted;

        if (isStale()) return;

        setLoading(true);
        const searchT0 = performance.now();
        try {
          if (liveSearchQueryRejected(q)) {
            if (!isStale()) {
              setResults(EMPTY_SEARCH_RESULTS);
              setSearchSource(null);
              setOpen(true);
            }
            return;
          }

          const raceCtx = { epoch: gen, isStale, suppressLog: indexEnabled && !!serverId };

            if (indexEnabled && serverId) {
              const winner = await raceLiveSearch(
                () => runLocalLiveSearch(serverId, q, raceCtx),
                () => runNetworkLiveSearch(q, abort.signal),
                isStale,
                meta => {
                  emitLiveSearchDebug('race_settled', {
                    query: q,
                    winner: meta.winner,
                    localMs: meta.localMs,
                    networkMs: meta.networkMs,
                    localHits: meta.localHits,
                    networkHits: meta.networkHits,
                  });
                  if (isStale()) return;
                  if (meta.localResult && meta.networkResult) {
                    const primary =
                      meta.winner === 'local' ? meta.localResult : meta.networkResult;
                    const supplement =
                      meta.winner === 'local' ? meta.networkResult : meta.localResult;
                    const merged = mergeLiveSearchResults(primary, supplement);
                    const primaryHits = searchHitCounts(primary);
                    const mergedHits = searchHitCounts(merged);
                    if (mergedHits !== primaryHits) {
                      setResults(merged);
                      setSearchSource(meta.winner);
                      emitLiveSearchDebug('race_merged', {
                        query: q,
                        winner: meta.winner,
                        before: primaryHits,
                        after: mergedHits,
                        samples: searchResultSamples(merged),
                      });
                    }
                  }
                },
              );
              if (isStale()) return;
              if (winner) {
                setResults(winner.result);
                setSearchSource(winner.source);
                setOpen(true);
                const samples = searchResultSamples(winner.result);
                emitLiveSearchDebug('race_winner', {
                  query: q,
                  winner: winner.source,
                  raceMs: winner.durationMs,
                  hits: searchHitCounts(winner.result),
                  samples,
                  path: 'search_race',
                  localReady: localReadyRef.current,
                });
                logLibrarySearch({
                  at: new Date().toISOString(),
                  query: q,
                  path: 'search_race',
                  surface: 'live_search',
                  durationMs: Math.round(performance.now() - searchT0),
                  debounceMs,
                  indexEnabled,
                  localReadyCached: localReadyRef.current,
                  raceWinner: winner.source,
                  raceWinnerMs: winner.durationMs,
                  counts: {
                    artists: winner.result.artists.length,
                    albums: winner.result.albums.length,
                    songs: winner.result.songs.length,
                  },
                });
                return;
              }
              showToast(t('search.liveSearchFailed'), 3200, 'error');
            } else if (serverId) {
            const network = await runNetworkLiveSearch(q, abort.signal);
            if (isStale()) return;
            if (network) {
              setResults(network);
              setSearchSource('network');
              setOpen(true);
              logLibrarySearch({
                at: new Date().toISOString(),
                query: q,
                path: 'search3',
                surface: 'live_search',
                source: 'network',
                durationMs: Math.round(performance.now() - searchT0),
                debounceMs,
                indexEnabled,
                counts: {
                  artists: network.artists.length,
                  albums: network.albums.length,
                  songs: network.songs.length,
                },
              });
            }
          }
        } catch (err) {
          if (isStale()) return;
          const name = err instanceof Error ? err.name : '';
          if (name === 'CanceledError' || name === 'AbortError') return;
          showToast(t('search.liveSearchFailed'), 3200, 'error');
        } finally {
          if (!isStale()) setLoading(false);
        }
      })();
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
      abort.abort();
      liveSearchGenRef.current += 1;
    };
  }, [query, scope, share.shareMatch, serverId, indexEnabled, musicLibraryFilterVersion, t]);

  const isSearchActive = isFocused || open || query.trim().length > 0 || scope != null;

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

  const hasResults =
    !!share.shareMatch ||
    (results && (results.artists.length || results.albums.length || results.songs.length));

  // Flat list of all navigable items for keyboard nav
  const flatItems = share.shareMatch && share.hasShareKeyboardTarget ? [
    {
      id: 'share-link',
      action: () => {
        if (share.canQueueShareMatch) void share.enqueueShareMatch();
        else if (share.canOpenShareAlbum) share.openShareAlbum();
        else if (share.canOpenShareArtist) share.openShareArtist();
        else if (share.canOpenShareComposer) share.openShareComposer();
      },
    },
  ] : results ? [
    ...(results.artists.map(a => ({ id: a.id, action: () => { navigate(`/artist/${a.id}`); setOpen(false); setQuery(''); } }))),
    ...(results.albums.map(a => ({ id: a.id, action: () => { navigateToAlbum(a.id); setOpen(false); setQuery(''); } }))),
   ...(results.songs.map(s => ({ id: s.id, action: () => {
       const track = songToTrack(s);
       enqueue([track]);
       showToast(t('search.addedToQueueToast', { title: track.title }), 2200, 'info');
       setOpen(false); setQuery('');
     }}))),
  ] : [];

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (handleLiveSearchScopeUndo(e, undoLiveSearch)) return;
    if (handleLiveSearchScopeBackspace(e, query, scope, clearScope, scopeBackspaceRef.current)) return;
    if (isLiveSearchDropdownBlocked(scope)) return;
    if (share.shareMatch) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (share.canQueueShareMatch) void share.enqueueShareMatch();
        else if (share.canOpenShareAlbum) share.openShareAlbum();
        else if (share.canOpenShareArtist) share.openShareArtist();
        else if (share.canOpenShareComposer) share.openShareComposer();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex(share.hasShareKeyboardTarget ? 0 : -1);
      } else if (e.key === 'Escape') {
        setOpen(false);
        setActiveIndex(-1);
      }
      return;
    }
    if (!open || !flatItems.length) {
      if (e.key === 'Enter' && query.trim()) {
        e.preventDefault();
        leaveLiveSearchFor(`/search?q=${encodeURIComponent(query.trim())}`);
      }
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
      else if (query.trim()) {
        leaveLiveSearchFor(`/search?q=${encodeURIComponent(query.trim())}`);
      }
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
        <div className="live-search-field-cluster">
          {loading ? (
            <span className="live-search-leading-icon animate-spin" style={{ opacity: 0.6 }}>
              <div style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%' }} />
            </span>
          ) : (
            <Search size={16} className="live-search-leading-icon" aria-hidden />
          )}
          {scope && (
            <LiveSearchScopeBadge
              scope={scope}
              className="live-search-scope-badge"
              clearScope={clearScope}
            />
          )}
          {ghostScope && (
            <LiveSearchScopeGhostBadge
              scope={ghostScope}
              className="live-search-scope-badge live-search-scope-badge--ghost"
              setScope={setScope}
            />
          )}
          <input
            ref={inputRef}
            id="live-search-input"
            className="input live-search-field"
            type="search"
            placeholder={t(liveSearchScopePlaceholderKey(scope))}
            data-tooltip={scope ? t(liveSearchScopePlaceholderKey(scope)) : undefined}
            data-tooltip-pos="bottom"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            onFocus={() => {
              setIsFocused(true);
              if (!isLiveSearchDropdownBlocked(scope) && results) setOpen(true);
            }}
            onBlur={() => setIsFocused(false)}
            onKeyDown={handleKeyDown}
            aria-autocomplete="list"
            aria-controls="search-results"
            aria-expanded={open && !isLiveSearchDropdownBlocked(scope)}
            autoComplete="off"
          />
        </div>
        <button
          className="live-search-adv-btn"
          type="button"
          onMouseDown={(e) => {
            // Keep focus on the search input so collapsed-overlay controls
            // remain active long enough for this button click to fire.
            e.preventDefault();
          }}
          onClick={() => {
            const q = query.trim();
            leaveLiveSearchFor(q ? `/search/advanced?q=${encodeURIComponent(q)}` : '/search/advanced');
          }}
          data-tooltip={t('search.advanced')}
          data-tooltip-pos="bottom"
          aria-label={t('search.advanced')}
        >
          <TextSearch size={14} />
        </button>
      </div>

      {open && !isLiveSearchDropdownBlocked(scope) && (
        <div className="live-search-dropdown" id="search-results" role="listbox" ref={dropdownRef}>
          {searchSource && !share.shareMatch && (
            <div
              className={`live-search-source live-search-source--${searchSource}`}
              data-tooltip={t(
                searchSource === 'local'
                  ? 'search.localIndexBadgeTooltip'
                  : 'search.networkSearchBadgeTooltip',
              )}
              data-tooltip-pos="bottom"
            >
              {searchSource === 'local' ? (
                <Database size={12} aria-hidden />
              ) : (
                <Globe size={12} aria-hidden />
              )}
              <span>
                {t(
                  searchSource === 'local'
                    ? 'search.localIndexBadge'
                    : 'search.networkSearchBadge',
                )}
              </span>
            </div>
          )}

          {!hasResults && !loading && (
            <div className="search-empty">{t('search.noResults', { query: query.trim() })}</div>
          )}

          {share.shareMatch && (
            <ShareSearchResults
              variant="desktop"
              shareMatch={share.shareMatch}
              shareServerLabel={share.shareServerLabel}
              shareCoverServer={share.shareCoverServer}
              activeIndex={activeIndex}
              shareQueueBusy={share.shareQueueBusy}
              onEnqueue={() => void share.enqueueShareMatch()}
              onOpenAlbum={share.openShareAlbum}
              onOpenArtist={share.openShareArtist}
              onOpenComposer={share.openShareComposer}
              onContextMenu={(e, item, type) => openContextMenu(e.clientX, e.clientY, item, type)}
              shareTrackSong={share.shareTrackSong}
              shareTrackResolving={share.shareTrackResolving}
              shareTrackUnavailable={share.shareTrackUnavailable}
              shareAlbum={share.shareAlbum}
              shareAlbumResolving={share.shareAlbumResolving}
              shareAlbumUnavailable={share.shareAlbumUnavailable}
              shareArtist={share.shareArtist}
              shareArtistResolving={share.shareArtistResolving}
              shareArtistUnavailable={share.shareArtistUnavailable}
              shareComposer={share.shareComposer}
              shareComposerResolving={share.shareComposerResolving}
              shareComposerUnavailable={share.shareComposerUnavailable}
            />
          )}

          {(() => {
            if (share.shareMatch) return null;
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
                        onClick={() => { navigateToAlbum(a.id); setOpen(false); setQuery(''); }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          openContextMenu(e.clientX, e.clientY, a, 'album');
                        }}
                        role="option" aria-selected={activeIndex === i}>
                        {a.coverArt ? (
                          <LiveSearchAlbumThumb albumId={a.id} coverArt={a.coverArt} />
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
                        {(s.coverArt ?? s.albumId) ? (
                          <LiveSearchSongThumb song={s} />
                        ) : (
                          <div className="search-result-icon"><Music size={14} /></div>
                        )}
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
