import { search } from '@/lib/api/subsonicSearch';
import type { SearchResults, SubsonicArtist } from '@/lib/api/subsonicTypes';
import { songToTrack } from '@/lib/media/songToTrack';
import { useLiveSearchScopeStore } from '@/store/liveSearchScopeStore';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { navigatePathWithAlbumReturnTo } from '@/lib/navigation/albumDetailNavigation';
import { X, Search, Disc3, Users, Music, Music2, Clock, ChevronRight } from 'lucide-react';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { useTranslation } from 'react-i18next';
import { FETCH_QUEUE_BIAS_SEARCH_ARTIST_OVER_ALBUM } from '@/ui/CachedImage';
import { AlbumCoverArtImage } from '@/cover/AlbumCoverArtImage';
import { ArtistCoverArtImage } from '@/cover/ArtistCoverArtImage';
import { CoverArtImage } from '@/cover/CoverArtImage';
import { albumCoverRefForSong } from '@/cover/ref';
import { showToast } from '@/lib/dom/toast';
import { albumArtistDisplayName } from '@/features/album';
import { useShareSearch } from '@/features/search/hooks/useShareSearch';
import ShareSearchResults from '@/features/search/components/ShareSearchResults';
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

function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: A) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

/** Mobile search row thumb — larger than desktop live search (32px). */
const MOBILE_SEARCH_THUMB_CSS_PX = 80;

function MobileSearchSongThumb({
  song,
}: {
  song: Pick<SearchResults['songs'][number], 'id' | 'albumId' | 'coverArt' | 'discNumber'>;
}) {
  const coverRef = useMemo(
    () => (song.albumId?.trim() ? albumCoverRefForSong(song) : undefined),
    // Keyed on song's identity fields; depending on the `song` object would
    // recompute the ref on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [song.id, song.albumId, song.coverArt, song.discNumber],
  );
  if (!coverRef) return null;
  return (
    <CoverArtImage
      coverRef={coverRef}
      displayCssPx={MOBILE_SEARCH_THUMB_CSS_PX}
      surface="dense"
      className="mobile-search-thumb"
      alt=""
      ensurePriority="high"
    />
  );
}

function MobileSearchArtistThumb({ artist }: { artist: Pick<SubsonicArtist, 'id' | 'coverArt'> }) {
  const [failed, setFailed] = useState(false);
  // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setFailed(false); }, [artist.id, artist.coverArt]);
  if (failed) {
    return (
      <div className="mobile-search-avatar mobile-search-avatar--circle">
        <Users size={20} />
      </div>
    );
  }
  return (
    <ArtistCoverArtImage
      artistId={artist.id}
      coverArt={artist.coverArt}
      libraryResolve={false}
      displayCssPx={MOBILE_SEARCH_THUMB_CSS_PX}
      surface="dense"
      className="mobile-search-thumb mobile-search-thumb--artist-round"
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
  const location = useLocation();
  const enqueue = usePlayerStore(s => s.enqueue);

  const query = useLiveSearchScopeStore(s => s.query);
  const setQuery = useLiveSearchScopeStore(s => s.setQuery);
  const scope = useLiveSearchScopeStore(s => s.scope);
  const setScope = useLiveSearchScopeStore(s => s.setScope);
  const clearScope = useLiveSearchScopeStore(s => s.clearScope);
  const undoLiveSearch = useLiveSearchScopeStore(s => s.undo);
  const scopeBackspaceRef = useRef(createLiveSearchScopeBackspaceState());
  const ghostScope = resolveLiveSearchScopeGhost(location.pathname, scope);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(loadRecent);
  const inputRef = useRef<HTMLInputElement>(null);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const share = useShareSearch(query, onClose);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    resetLiveSearchScopeBackspaceState(scopeBackspaceRef.current);
  }, [scope]);

  useEffect(() => {
    noteLiveSearchScopeQueryInput(scopeBackspaceRef.current, query);
  }, [query]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // doSearch wraps a debounce() result, so the useCallback argument is not an
  // inline function and its deps can't be statically analysed. It is recreated
  // only on musicLibraryFilterVersion (search() reads the active filter state).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const doSearch = useCallback(
    // React Compiler rule: memoization shape is intentional here.
    // eslint-disable-next-line react-hooks/use-memo
    debounce(async (q: string) => {
      if (!q.trim()) { setResults(null); setLoading(false); return; }
      setLoading(true);
      try {
        setResults(await search(q));
      } finally { setLoading(false); }
    }, 300),
    [musicLibraryFilterVersion],
  );

  useEffect(() => {
    if (isLiveSearchDropdownBlocked(scope)) {
      // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults(null);
      setLoading(false);
      return;
    }
    if (share.shareMatch) {
      setResults(null);
      setLoading(false);
      return;
    }
    doSearch(query);
  }, [query, scope, doSearch, share.shareMatch]);

  const commit = (q: string) => {
    if (q.trim()) setRecentSearches(prev => saveRecent(q, prev));
  };

  const goTo = (path: string) => {
    commit(query);
    navigatePathWithAlbumReturnTo(navigate, location, path);
    onClose();
  };
  const goCategory = (path: string) => { navigate(path); onClose(); };
  const enqueueSong = (song: SearchResults['songs'][number]) => {
    commit(query);
    const track = songToTrack(song);
    enqueue([track]);
    showToast(t('search.addedToQueueToast', { title: track.title }), 2200, 'info');
    onClose();
  };
  const applyRecentSearch = (term: string) => {
    setQuery(term, { recordUndo: true });
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

  const hasResults =
    !isLiveSearchDropdownBlocked(scope)
    && (
      !!share.shareMatch
      || (results && (results.artists.length || results.albums.length || results.songs.length))
    );
  const showEmpty = !query && !scope;

  return createPortal(
    <div className="mobile-search-overlay">
      {/* ── Search bar ── */}
      <div className="mobile-search-bar">
        <div className={`mobile-search-field${scope ? ' mobile-search-field--scoped' : ''}`}>
          {loading ? (
            <div className="mobile-search-spinner" />
          ) : (
            <Search size={16} className="mobile-search-icon" />
          )}
          {scope && (
            <LiveSearchScopeBadge
              scope={scope}
              className="mobile-search-scope-badge"
              clearScope={clearScope}
            />
          )}
          {ghostScope && (
            <LiveSearchScopeGhostBadge
              scope={ghostScope}
              className="mobile-search-scope-badge mobile-search-scope-badge--ghost"
              setScope={setScope}
            />
          )}
          <input
            ref={inputRef}
            className="mobile-search-input"
            type="search"
            placeholder={t(liveSearchScopePlaceholderKey(scope))}
            data-tooltip={scope ? t(liveSearchScopePlaceholderKey(scope)) : undefined}
            data-tooltip-pos="bottom"
            value={query}
            onChange={e => setQuery(e.target.value, { recordUndo: true })}
            onKeyDown={(e) => {
              if (handleLiveSearchScopeUndo(e, undoLiveSearch)) return;
              if (handleLiveSearchScopeBackspace(e, query, scope, clearScope, scopeBackspaceRef.current)) return;
            }}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
          {query && (
            <button
              className="mobile-search-clear"
              onClick={() => { setQuery('', { recordUndo: true }); setResults(null); inputRef.current?.focus(); }}
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
                  <button key={term} className="mobile-search-item" onClick={() => applyRecentSearch(term)}>
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
        {!loading && query && !hasResults && !isLiveSearchDropdownBlocked(scope) && (
          <div className="mobile-search-noresults">
            {t('search.noResults', { query: query.trim() })}
          </div>
        )}

        {share.shareMatch && (
          <ShareSearchResults
            variant="mobile"
            shareMatch={share.shareMatch}
            shareServerLabel={share.shareServerLabel}
            shareCoverServer={share.shareCoverServer}
            shareQueueBusy={share.shareQueueBusy}
            onEnqueue={() => void share.enqueueShareMatch()}
            onOpenAlbum={share.openShareAlbum}
            onOpenArtist={share.openShareArtist}
            onOpenComposer={share.openShareComposer}
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

        {/* ── Results ── */}
        {hasResults && !share.shareMatch && (
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
                      <AlbumCoverArtImage
                        albumId={a.id}
                        coverArt={a.coverArt}
                        libraryResolve={false}
                        displayCssPx={MOBILE_SEARCH_THUMB_CSS_PX}
                        surface="dense"
                        className="mobile-search-thumb"
                        alt=""
                        ensurePriority="high"
                      />
                    ) : (
                      <div className="mobile-search-avatar">
                        <Disc3 size={20} />
                      </div>
                    )}
                    <div className="mobile-search-item-info">
                      <span className="mobile-search-item-title">{a.name}</span>
                      <span className="mobile-search-item-sub">{albumArtistDisplayName(a)}</span>
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
                    {s.albumId && (s.coverArt ?? s.albumId) ? (
                      <MobileSearchSongThumb song={s} />
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
