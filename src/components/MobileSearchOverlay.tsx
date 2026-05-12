import type { SearchResults, SubsonicArtist } from '../api/subsonicTypes';
import { songToTrack } from '../utils/songToTrack';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { X, Search, Disc3, Users, Music, Music2, Clock, ChevronRight } from 'lucide-react';
import { search, buildCoverArtUrl, coverArtCacheKey } from '../api/subsonic';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from 'react-i18next';
import CachedImage, { FETCH_QUEUE_BIAS_SEARCH_ARTIST_OVER_ALBUM } from './CachedImage';
import { showToast } from '../utils/toast';

const STORAGE_KEY = 'psysonic_recent_searches';
const MAX_RECENT = 6;

function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}

function saveRecent(q: string, prev: string[]): string[] {
  const updated = [q.trim(), ...prev.filter(s => s !== q.trim())].slice(0, MAX_RECENT);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return updated;
}

function debounce(fn: (q: string) => void, ms: number): (q: string) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (q: string) => { clearTimeout(timer); timer = setTimeout(() => fn(q), ms); };
}

function MobileSearchArtistThumb({ artist }: { artist: Pick<SubsonicArtist, 'id' | 'coverArt'> }) {
  const [failed, setFailed] = useState(false);
  const coverId = artist.coverArt || artist.id;
  const src = useMemo(() => buildCoverArtUrl(coverId, 80), [coverId]);
  const ck = useMemo(() => coverArtCacheKey(coverId, 80), [coverId]);
  useEffect(() => { setFailed(false); }, [coverId]);
  if (failed) {
    return (
      <div className="mobile-search-avatar mobile-search-avatar--circle">
        <Users size={20} />
      </div>
    );
  }
  return (
    <CachedImage
      className="mobile-search-thumb mobile-search-thumb--artist-round"
      src={src}
      cacheKey={ck}
      alt=""
      loading="eager"
      fetchQueueBias={FETCH_QUEUE_BIAS_SEARCH_ARTIST_OVER_ALBUM}
      onError={() => setFailed(true)}
    />
  );
}

export default function MobileSearchOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const enqueue = usePlayerStore(s => s.enqueue);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(loadRecent);
  const inputRef = useRef<HTMLInputElement>(null);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const doSearch = useCallback(
    debounce(async (q: string) => {
      if (!q.trim()) { setResults(null); setLoading(false); return; }
      setLoading(true);
      try { setResults(await search(q)); }
      finally { setLoading(false); }
    }, 300),
    [musicLibraryFilterVersion]
  );

  useEffect(() => { doSearch(query); }, [query, doSearch]);

  const commit = (q: string) => {
    if (q.trim()) setRecentSearches(prev => saveRecent(q, prev));
  };

  const goTo = (path: string) => { commit(query); navigate(path); onClose(); };
  const goCategory = (path: string) => { navigate(path); onClose(); };
  const enqueueSong = (song: SearchResults['songs'][number]) => {
    commit(query);
    const track = songToTrack(song);
    enqueue([track]);
    showToast(t('search.addedToQueueToast', { title: track.title }), 2200, 'info');
    onClose();
  };
  const useRecent = (term: string) => {
    setQuery(term);
    inputRef.current?.focus();
  };
  const removeRecent = (term: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRecentSearches(prev => {
      const updated = prev.filter(s => s !== term);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      return updated;
    });
  };

  const hasResults = results && (results.artists.length || results.albums.length || results.songs.length);
  const showEmpty = !query;

  return createPortal(
    <div className="mobile-search-overlay">
      {/* ── Search bar ── */}
      <div className="mobile-search-bar">
        <div className="mobile-search-field">
          {loading ? (
            <div className="mobile-search-spinner" />
          ) : (
            <Search size={16} className="mobile-search-icon" />
          )}
          <input
            ref={inputRef}
            className="mobile-search-input"
            type="search"
            placeholder={t('search.placeholder')}
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
          {query && (
            <button
              className="mobile-search-clear"
              onClick={() => { setQuery(''); setResults(null); inputRef.current?.focus(); }}
              aria-label={t('search.clearLabel')}
            >
              <X size={15} />
            </button>
          )}
        </div>
        <button className="mobile-search-cancel" onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>

      <div className="mobile-search-results">
        {/* ── Empty state ── */}
        {showEmpty && (
          <div className="mobile-search-empty-state">
            {recentSearches.length > 0 && (
              <div className="mobile-search-section">
                <div className="mobile-search-section-label">{t('search.recentSearches')}</div>
                {recentSearches.map(term => (
                  <button key={term} className="mobile-search-item" onClick={() => useRecent(term)}>
                    <div className="mobile-search-avatar">
                      <Clock size={18} />
                    </div>
                    <div className="mobile-search-item-info" style={{ flex: 1 }}>
                      <span className="mobile-search-item-title">{term}</span>
                    </div>
                    <button
                      className="mobile-search-recent-remove"
                      onClick={e => removeRecent(term, e)}
                      aria-label={t('search.clearLabel')}
                    >
                      <X size={14} />
                    </button>
                  </button>
                ))}
              </div>
            )}

            <div className="mobile-search-section">
              <div className="mobile-search-section-label">{t('search.browse')}</div>
              <div className="mobile-search-chips">
                <button className="mobile-search-chip" onClick={() => goCategory('/albums')}>
                  <Music2 size={15} /> {t('search.albums')}
                </button>
                <button className="mobile-search-chip" onClick={() => goCategory('/artists')}>
                  <Users size={15} /> {t('search.artists')}
                </button>
                <button className="mobile-search-chip" onClick={() => goCategory('/genres')}>
                  <Music size={15} /> {t('search.genres')}
                </button>
              </div>
            </div>

            <div className="mobile-search-hint">
              <Search size={52} className="mobile-search-hint-icon" />
              <span className="mobile-search-hint-text">{t('search.emptyHint')}</span>
            </div>
          </div>
        )}

        {/* ── No results ── */}
        {!loading && query && !hasResults && (
          <div className="mobile-search-noresults">
            {t('search.noResults', { query })}
          </div>
        )}

        {/* ── Results ── */}
        {hasResults && (
          <>
            {results!.artists.length > 0 && (
              <div className="mobile-search-section">
                <div className="mobile-search-section-label">{t('search.artists')}</div>
                {results!.artists.map(a => (
                  <button key={a.id} className="mobile-search-item" onClick={() => goTo(`/artist/${a.id}`)}>
                    <MobileSearchArtistThumb artist={a} />
                    <div className="mobile-search-item-info">
                      <span className="mobile-search-item-title">{a.name}</span>
                      <span className="mobile-search-item-sub">{t('search.artists')}</span>
                    </div>
                    <ChevronRight size={16} className="mobile-search-item-chevron" />
                  </button>
                ))}
              </div>
            )}

            {results!.albums.length > 0 && (
              <div className="mobile-search-section">
                <div className="mobile-search-section-label">{t('search.albums')}</div>
                {results!.albums.map(a => (
                  <button key={a.id} className="mobile-search-item" onClick={() => goTo(`/album/${a.id}`)}>
                    {a.coverArt ? (
                      <CachedImage
                        className="mobile-search-thumb"
                        src={buildCoverArtUrl(a.coverArt, 80)}
                        cacheKey={coverArtCacheKey(a.coverArt, 80)}
                        alt=""
                      />
                    ) : (
                      <div className="mobile-search-avatar">
                        <Disc3 size={20} />
                      </div>
                    )}
                    <div className="mobile-search-item-info">
                      <span className="mobile-search-item-title">{a.name}</span>
                      <span className="mobile-search-item-sub">{a.artist}</span>
                    </div>
                    <ChevronRight size={16} className="mobile-search-item-chevron" />
                  </button>
                ))}
              </div>
            )}

            {results!.songs.length > 0 && (
              <div className="mobile-search-section">
                <div className="mobile-search-section-label">{t('search.songs')}</div>
                {results!.songs.map(s => (
                  <button key={s.id} className="mobile-search-item" onClick={() => enqueueSong(s)}>
                    {s.coverArt ? (
                      <CachedImage
                        className="mobile-search-thumb"
                        src={buildCoverArtUrl(s.coverArt, 80)}
                        cacheKey={coverArtCacheKey(s.coverArt, 80)}
                        alt=""
                      />
                    ) : (
                      <div className="mobile-search-avatar">
                        <Music size={20} />
                      </div>
                    )}
                    <div className="mobile-search-item-info">
                      <span className="mobile-search-item-title">{s.title}</span>
                      <span className="mobile-search-item-sub">{s.artist}{s.album ? ` · ${s.album}` : ''}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
