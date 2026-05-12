import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import { getArtists } from '../api/subsonicArtists';
import type { SubsonicArtist } from '../api/subsonicTypes';
import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { LayoutGrid, List, Images, CheckSquare2, ListMusic, Check } from 'lucide-react';
import StarFilterButton from '../components/StarFilterButton';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import CachedImage from '../components/CachedImage';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import { useElementClientHeightById } from '../hooks/useResizeClientHeight';
import { usePerfProbeFlags } from '../utils/perfFlags';

const ALL_SENTINEL = 'ALL';
const ALPHABET = [ALL_SENTINEL, '#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];

/** Virtual row height guesses — letter heading vs dense rows vs last row in section (group gap). */
const ARTIST_LIST_LETTER_ROW_EST = 48;
const ARTIST_LIST_ROW_EST = 64;
const ARTIST_LIST_LAST_IN_LETTER_EST = 88;

type ArtistListFlatRow =
  | { kind: 'letter'; letter: string }
  | { kind: 'artist'; artist: SubsonicArtist; isLastInLetter: boolean };

// Catppuccin accent colors — one is picked deterministically from the artist name
const CTP_COLORS = [
  'var(--ctp-rosewater)', 'var(--ctp-flamingo)', 'var(--ctp-pink)',    'var(--ctp-mauve)',
  'var(--ctp-red)',       'var(--ctp-maroon)',    'var(--ctp-peach)',   'var(--ctp-yellow)',
  'var(--ctp-green)',     'var(--ctp-teal)',      'var(--ctp-sky)',     'var(--ctp-sapphire)',
  'var(--ctp-blue)',      'var(--ctp-lavender)',
];

function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CTP_COLORS[h % CTP_COLORS.length];
}

function nameInitial(name: string): string {
  // \p{L} matches any Unicode letter — covers cyrillic, arabic, CJK, etc.
  const letter = name.match(/\p{L}/u)?.[0];
  if (letter) return letter.toUpperCase();
  const alnum = name.match(/[0-9]/)?.[0];
  return alnum ?? '?';
}

function ArtistCardAvatar({ artist, showImages }: { artist: SubsonicArtist; showImages: boolean }) {
  const color = nameColor(artist.name);
  const coverId = artist.coverArt || artist.id;
  const { coverSrc, coverKey } = useMemo(
    () => ({
      coverSrc: coverId ? buildCoverArtUrl(coverId, 300) : '',
      coverKey: coverId ? coverArtCacheKey(coverId, 300) : '',
    }),
    [coverId],
  );
  if (showImages && coverId) {
    return (
      <div className="artist-card-avatar">
        <CachedImage
          src={coverSrc}
          cacheKey={coverKey}
          alt={artist.name}
        />
      </div>
    );
  }
  return (
    <div className="artist-card-avatar artist-card-avatar-initial" style={{ borderColor: color }}>
      <span style={{ color }}>{nameInitial(artist.name)}</span>
    </div>
  );
}

function ArtistRowAvatar({ artist, showImages }: { artist: SubsonicArtist; showImages: boolean }) {
  const color = nameColor(artist.name);
  const coverId = artist.coverArt || artist.id;
  const { coverSrc, coverKey } = useMemo(
    () => ({
      coverSrc: coverId ? buildCoverArtUrl(coverId, 64) : '',
      coverKey: coverId ? coverArtCacheKey(coverId, 64) : '',
    }),
    [coverId],
  );
  if (showImages && coverId) {
    return (
      <div className="artist-avatar">
        <CachedImage
          src={coverSrc}
          cacheKey={coverKey}
          alt={artist.name}
          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
        />
      </div>
    );
  }
  return (
    <div className="artist-avatar artist-avatar-initial" style={{ borderColor: color }}>
      <span style={{ color }}>{nameInitial(artist.name)}</span>
    </div>
  );
}

export default function Artists() {
  const perfFlags = usePerfProbeFlags();
  const { t } = useTranslation();
  const [artists, setArtists] = useState<SubsonicArtist[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [letterFilter, setLetterFilter] = useState(ALL_SENTINEL);
  const [starredOnly, setStarredOnly] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const showArtistImages = useAuthStore(s => s.showArtistImages);
  const PAGE_SIZE = showArtistImages ? 50 : 100; // Smaller with images to reduce I/O
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const observerTarget = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const openContextMenu = usePlayerStore(state => state.openContextMenu);
  const setShowArtistImages = useAuthStore(s => s.setShowArtistImages);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

  // ── Multi-selection ──────────────────────────────────────────────────────
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelectionMode = () => {
    setSelectionMode(v => !v);
    setSelectedIds(new Set());
  };

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const selectedArtists = artists.filter(a => selectedIds.has(a.id));

  useEffect(() => {
    getArtists().then(data => { setArtists(data); setLoading(false); }).catch(() => setLoading(false));
  }, [musicLibraryFilterVersion]);

  const loadMore = useCallback(() => {
    if (loadingMore) return;
    setLoadingMore(true);
    setVisibleCount(prev => prev + PAGE_SIZE);
    setTimeout(() => setLoadingMore(false), 100);
  }, [loadingMore, PAGE_SIZE]);

  // Reset infinite scroll when filters or image setting change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filter, letterFilter, starredOnly, viewMode, PAGE_SIZE]);

  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  // Filter pipeline — memoised so unrelated state changes (selection mode,
  // viewMode, etc.) don't re-iterate the full artists array. With 5000+
  // artists each re-render walked the list twice without this.
  const filtered = useMemo(() => {
    let out = artists;
    if (letterFilter !== ALL_SENTINEL) {
      out = out.filter(a => {
        const first = a.name[0]?.toUpperCase() ?? '#';
        const isAlpha = /^[A-Z]$/.test(first);
        if (letterFilter === '#') return !isAlpha;
        return first === letterFilter;
      });
    }
    if (filter) {
      const needle = filter.toLowerCase();
      out = out.filter(a => a.name.toLowerCase().includes(needle));
    }
    if (starredOnly) {
      out = out.filter(a => a.id in starredOverrides ? starredOverrides[a.id] : !!a.starred);
    }
    return out;
  }, [artists, letterFilter, filter, starredOnly, starredOverrides]);

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const hasMore = visibleCount < filtered.length;

  // Intersection Observer for infinite scroll (after hasMore declaration)
  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: '200px' }
    );
    if (observerTarget.current) observer.observe(observerTarget.current);
    return () => observer.disconnect();
  }, [loadMore, hasMore]);

  // Group by first letter (for list view) — only recompute when the visible
  // slice or the view mode actually changes. Skipped entirely in grid view.
  const { groups, letters } = useMemo(() => {
    if (viewMode !== 'list') return { groups: {} as Record<string, SubsonicArtist[]>, letters: [] as string[] };
    const g: Record<string, SubsonicArtist[]> = {};
    for (const a of visible) {
      const letter = a.name[0]?.toUpperCase() ?? '#';
      const key = /^[A-Z]$/.test(letter) ? letter : '#';
      if (!g[key]) g[key] = [];
      g[key].push(a);
    }
    return { groups: g, letters: Object.keys(g).sort() };
  }, [visible, viewMode]);

  const artistListFlatRows = useMemo((): ArtistListFlatRow[] => {
    if (viewMode !== 'list') return [];
    const out: ArtistListFlatRow[] = [];
    for (const letter of letters) {
      out.push({ kind: 'letter', letter });
      const group = groups[letter];
      for (let i = 0; i < group.length; i++) {
        out.push({ kind: 'artist', artist: group[i], isLastInLetter: i === group.length - 1 });
      }
    }
    return out;
  }, [viewMode, letters, groups]);

  const mainScrollViewportHeight = useElementClientHeightById(APP_MAIN_SCROLL_VIEWPORT_ID);
  /** Mixed row heights; smallest typical step ≈ artist row — one viewport of extra indices each side. */
  const artistListOverscan = Math.max(
    12,
    Math.ceil(mainScrollViewportHeight / ARTIST_LIST_ROW_EST),
  );

  const artistListVirtualizer = useVirtualizer({
    count:
      perfFlags.disableMainstageVirtualLists || viewMode !== 'list' ? 0 : artistListFlatRows.length,
    getScrollElement: () => document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID),
    estimateSize: index => {
      const row = artistListFlatRows[index];
      if (!row) return ARTIST_LIST_ROW_EST;
      if (row.kind === 'letter') return ARTIST_LIST_LETTER_ROW_EST;
      return row.isLastInLetter ? ARTIST_LIST_LAST_IN_LETTER_EST : ARTIST_LIST_ROW_EST;
    },
    /** Stable keys — avoids row DOM reuse glitches when the filtered slice changes. */
    getItemKey: index => {
      const row = artistListFlatRows[index];
      if (!row) return index;
      if (row.kind === 'letter') return `letter:${row.letter}`;
      return `artist:${row.artist.id}`;
    },
    overscan: artistListOverscan,
  });

  return (
    <div className="content-body animate-fade-in">
      <div className="page-sticky-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <h1 className="page-title" style={{ marginBottom: 0 }}>
              {selectionMode && selectedIds.size > 0
                ? t('artists.selectionCount', { count: selectedIds.size })
                : t('artists.title')}
            </h1>
            <input
              className="input"
              style={{ maxWidth: 220 }}
              placeholder={t('artists.search')}
              value={filter}
              onChange={e => setFilter(e.target.value)}
              id="artist-filter-input"
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {!(selectionMode && selectedIds.size > 0) && (<>
                <StarFilterButton size="compact" active={starredOnly} onChange={setStarredOnly} />
                <button
                  className={`btn btn-surface`}
                  onClick={() => setShowArtistImages(!showArtistImages)}
                  style={showArtistImages ? { background: 'var(--accent)', color: 'var(--ctp-crust)', padding: '0.5rem' } : { padding: '0.5rem' }}
                  data-tooltip={showArtistImages ? t('artists.imagesOn') : t('artists.imagesOff')}
                  data-tooltip-wrap
                >
                  <Images size={20} />
                </button>
                <button
                  className={`btn btn-surface ${viewMode === 'grid' ? 'btn-sort-active' : ''}`}
                  onClick={() => setViewMode('grid')}
                  style={viewMode === 'grid' ? { background: 'var(--accent)', color: 'var(--ctp-crust)', padding: '0.5rem' } : { padding: '0.5rem' }}
                  data-tooltip={t('artists.gridView')}
                >
                  <LayoutGrid size={20} />
                </button>
                <button
                  className={`btn btn-surface ${viewMode === 'list' ? 'btn-sort-active' : ''}`}
                  onClick={() => setViewMode('list')}
                  style={viewMode === 'list' ? { background: 'var(--accent)', color: 'var(--ctp-crust)', padding: '0.5rem' } : { padding: '0.5rem' }}
                  data-tooltip={t('artists.listView')}
                >
                  <List size={20} />
                </button>
              </>
            )}
            <button
              className={`btn btn-surface${selectionMode ? ' btn-sort-active' : ''}`}
              onClick={toggleSelectionMode}
              data-tooltip={selectionMode ? t('artists.cancelSelect') : t('artists.startSelect')}
              data-tooltip-pos="bottom"
              style={selectionMode ? { background: 'var(--accent)', color: 'var(--ctp-crust)' } : {}}
            >
              <CheckSquare2 size={15} />
              {selectionMode ? t('artists.cancelSelect') : t('artists.select')}
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: 'var(--space-4)' }}>
          {ALPHABET.map(l => (
            <button
              key={l}
              onClick={() => setLetterFilter(l)}
              className={`artists-alpha-btn${letterFilter === l ? ' artists-alpha-btn--active' : ''}`}
            >
              {l === ALL_SENTINEL ? t('artists.all') : l}
            </button>
          ))}
        </div>
      </div>

      {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}><div className="spinner" /></div>}

      {!loading && viewMode === 'grid' && (
        <div className="album-grid-wrap">
          {visible.map(artist => (
            <div
              key={artist.id}
              className={`artist-card${selectionMode && selectedIds.has(artist.id) ? ' selected' : ''}${selectionMode ? ' artist-card--selectable' : ''}`}
              onClick={() => {
                if (selectionMode) {
                  toggleSelect(artist.id);
                } else {
                  navigate(`/artist/${artist.id}`);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (selectionMode && selectedIds.size > 0) {
                  openContextMenu(e.clientX, e.clientY, selectedArtists, 'multi-artist');
                } else {
                  openContextMenu(e.clientX, e.clientY, artist, 'artist');
                }
              }}
              style={selectionMode && selectedIds.has(artist.id) ? {
                outline: '2px solid var(--accent)',
                outlineOffset: '2px',
                borderRadius: 'var(--radius-md)'
              } : {}}
            >
              {selectionMode && (
                <div className={`artist-card-select-check${selectedIds.has(artist.id) ? ' artist-card-select-check--on' : ''}`}>
                  {selectedIds.has(artist.id) && <Check size={14} strokeWidth={3} />}
                </div>
              )}
              <ArtistCardAvatar artist={artist} showImages={showArtistImages} />
              <div style={{ textAlign: 'center' }}>
                <div className="artist-card-name">{artist.name}</div>
                {artist.albumCount != null && (
                  <div className="artist-card-meta">{t('artists.albumCount', { count: artist.albumCount })}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && viewMode === 'list' && (
        perfFlags.disableMainstageVirtualLists ? (
          <>
            {letters.map(letter => (
              <div key={letter} style={{ marginBottom: '1.5rem' }}>
                <h3 className="letter-heading">{letter}</h3>
                <div className="artist-list">
                  {groups[letter].map(artist => (
                    <button
                      key={artist.id}
                      className={`artist-row${selectionMode && selectedIds.has(artist.id) ? ' selected' : ''}`}
                      onClick={() => {
                        if (selectionMode) {
                          toggleSelect(artist.id);
                        } else {
                          navigate(`/artist/${artist.id}`);
                        }
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (selectionMode && selectedIds.size > 0) {
                          openContextMenu(e.clientX, e.clientY, selectedArtists, 'multi-artist');
                        } else {
                          openContextMenu(e.clientX, e.clientY, artist, 'artist');
                        }
                      }}
                      id={`artist-${artist.id}`}
                      style={selectionMode && selectedIds.has(artist.id) ? {
                        background: 'var(--accent-dim)',
                        color: 'var(--accent)'
                      } : {}}
                    >
                      <ArtistRowAvatar artist={artist} showImages={showArtistImages} />
                      <div style={{ textAlign: 'left' }}>
                        <div className="artist-name">{artist.name}</div>
                        {artist.albumCount != null && (
                          <div className="artist-meta">{t('artists.albumCount', { count: artist.albumCount })}</div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </>
        ) : (
          <div style={{ position: 'relative', width: '100%' }}>
            <div
              style={{
                height: artistListFlatRows.length === 0 ? 0 : artistListVirtualizer.getTotalSize(),
                width: '100%',
                position: 'relative',
              }}
            >
              {artistListVirtualizer.getVirtualItems().map(vi => {
                const row = artistListFlatRows[vi.index];
                if (!row) return null;
                if (row.kind === 'letter') {
                  return (
                    <div
                      key={vi.key}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${vi.start}px)`,
                      }}
                    >
                      <h3 className="letter-heading">{row.letter}</h3>
                    </div>
                  );
                }
                const artist = row.artist;
                return (
                  <div
                    key={vi.key}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vi.start}px)`,
                      paddingBottom: row.isLastInLetter ? '1.5rem' : undefined,
                    }}
                  >
                    <button
                      type="button"
                      className={`artist-row${selectionMode && selectedIds.has(artist.id) ? ' selected' : ''}`}
                      onClick={() => {
                        if (selectionMode) {
                          toggleSelect(artist.id);
                        } else {
                          navigate(`/artist/${artist.id}`);
                        }
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (selectionMode && selectedIds.size > 0) {
                          openContextMenu(e.clientX, e.clientY, selectedArtists, 'multi-artist');
                        } else {
                          openContextMenu(e.clientX, e.clientY, artist, 'artist');
                        }
                      }}
                      id={`artist-${artist.id}`}
                      style={selectionMode && selectedIds.has(artist.id) ? {
                        background: 'var(--accent-dim)',
                        color: 'var(--accent)'
                      } : {}}
                    >
                      <ArtistRowAvatar artist={artist} showImages={showArtistImages} />
                      <div style={{ textAlign: 'left' }}>
                        <div className="artist-name">{artist.name}</div>
                        {artist.albumCount != null && (
                          <div className="artist-meta">{t('artists.albumCount', { count: artist.albumCount })}</div>
                        )}
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )
      )}

      {!loading && hasMore && (
        <div ref={observerTarget} style={{ height: '20px', margin: '2rem 0', display: 'flex', justifyContent: 'center' }}>
          {loadingMore && <div className="spinner" style={{ width: 20, height: 20 }} />}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
          {t('artists.notFound')}
        </div>
      )}
    </div>
  );
}
