import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Disc3, Users, Music, SlidersVertical, TextSearch } from 'lucide-react';
import { search, SearchResults, buildCoverArtUrl, coverArtCacheKey } from '../api/subsonic';
import { usePlayerStore, songToTrack } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from 'react-i18next';
import CachedImage from './CachedImage';
import { showToast } from '../utils/toast';

function debounce(fn: (q: string) => void, ms: number): (q: string) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (q: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(q), ms);
  };
}

export default function LiveSearch() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const navigate = useNavigate();
  const enqueue = usePlayerStore(state => state.enqueue);
  const openContextMenu = usePlayerStore(state => state.openContextMenu);
  const ctxIsOpen = usePlayerStore(state => state.contextMenu.isOpen);
  const ctxItemId = usePlayerStore(state => (state.contextMenu.item as { id?: string } | null)?.id);
  const ctxType   = usePlayerStore(state => state.contextMenu.type);
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

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

  useEffect(() => { doSearch(query); setActiveIndex(-1); }, [query, doSearch]);

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

  const hasResults = results && (results.artists.length || results.albums.length || results.songs.length);

  // Flat list of all navigable items for keyboard nav
  const flatItems = results ? [
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
    <div className="live-search" ref={ref} role="search">
      <div className="live-search-input-wrap">
        {loading ? (
          <span className="live-search-icon animate-spin" style={{ opacity: 0.6 }}>
            <div style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%' }} />
          </span>
        ) : (
          <Search size={16} className="live-search-icon" />
        )}
        <input
          id="live-search-input"
          className="input live-search-field"
          type="search"
          placeholder={t('search.placeholder')}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => results && setOpen(true)}
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

          {(() => {
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
                        <div className="search-result-icon"><Users size={14} /></div>
                        <span>{a.name}</span>
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
                          <CachedImage
                            className="search-result-thumb"
                            src={buildCoverArtUrl(a.coverArt, 40)}
                            cacheKey={coverArtCacheKey(a.coverArt, 40)}
                            alt=""
                          />
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
