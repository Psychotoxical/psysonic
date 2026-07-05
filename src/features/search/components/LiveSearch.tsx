import type { SearchResults } from '@/lib/api/subsonicTypes';
import { songToTrack } from '@/lib/media/songToTrack';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useNavigateToAlbum } from '@/features/album';
import { Search, TextSearch } from 'lucide-react';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useTranslation } from 'react-i18next';
import { useLiveSearchHeaderCollapse } from '@/features/search/hooks/useLiveSearchHeaderCollapse';
import { useLiveSearchQuery } from '@/features/search/hooks/useLiveSearchQuery';
import LiveSearchDropdown, { type LiveSearchSource } from '@/features/search/components/LiveSearchDropdown';
import { showToast } from '@/lib/dom/toast';
import { useShareSearch } from '@/features/search/hooks/useShareSearch';
import {
  LiveSearchScopeBadge,
  LiveSearchScopeGhostBadge,
} from '@/features/search/components/liveSearchScopeUi';
import {
  createLiveSearchScopeBackspaceState,
  handleLiveSearchScopeBackspace,
  handleLiveSearchScopeUndo,
  isLiveSearchDropdownBlocked,
  liveSearchScopePlaceholderKey,
  noteLiveSearchScopeQueryInput,
  resetLiveSearchScopeBackspaceState,
  resolveLiveSearchScopeGhost,
} from '@/features/search/components/liveSearchScope';
import { useLiveSearchScopeStore } from '@/store/liveSearchScopeStore';

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
  const [searchSource, setSearchSource] = useState<LiveSearchSource | null>(null);
  const liveSearchGenRef = useRef(0);
  const navigate = useNavigate();
  const navigateToAlbum = useNavigateToAlbum();
  const enqueue = usePlayerStore(state => state.enqueue);
  const ctxIsOpen = usePlayerStore(state => state.contextMenu.isOpen);
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isCollapsed = useLiveSearchHeaderCollapse(ref);

  useEffect(() => {
    resetLiveSearchScopeBackspaceState(scopeBackspaceRef.current);
  }, [scope]);

  useEffect(() => {
    noteLiveSearchScopeQueryInput(scopeBackspaceRef.current, query);
  }, [query]);

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

  useLiveSearchQuery({
    query,
    scope,
    shareMatch: share.shareMatch,
    liveSearchGenRef,
    setResults,
    setOpen,
    setLoading,
    setSearchSource,
    setActiveIndex,
  });

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
        <LiveSearchDropdown
          dropdownRef={dropdownRef}
          results={results}
          searchSource={searchSource}
          activeIndex={activeIndex}
          loading={loading}
          share={share}
          setOpen={setOpen}
        />
      )}
    </div>
  );
}
