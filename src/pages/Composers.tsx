import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubsonicArtist } from '../api/subsonic';
import { ndListArtistsByRole } from '../api/navidromeBrowse';
import { LayoutGrid, List } from 'lucide-react';
import StarFilterButton from '../components/StarFilterButton';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import { useElementClientHeightById } from '../hooks/useResizeClientHeight';
import { usePerfProbeFlags } from '../utils/perfFlags';

const ALL_SENTINEL = 'ALL';
const ALPHABET = [ALL_SENTINEL, '#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];

const COMPOSER_LIST_LETTER_ROW_EST = 48;
const COMPOSER_LIST_ROW_EST = 64;
const COMPOSER_LIST_LAST_IN_LETTER_EST = 88;

type ComposerListFlatRow =
  | { kind: 'letter'; letter: string }
  | { kind: 'artist'; artist: SubsonicArtist; isLastInLetter: boolean };

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
  const letter = name.match(/\p{L}/u)?.[0];
  if (letter) return letter.toUpperCase();
  const alnum = name.match(/[0-9]/)?.[0];
  return alnum ?? '?';
}

// Composer libraries don't carry useful imagery (classical tagging conventions
// rarely populate cover/photo fields, and Navidrome's role-listing endpoint
// returns no image URLs anyway). The grid is text-only — large name plus
// participation count. The list view still draws a coloured initial circle so
// it doesn't collapse to a row of bare names.
function ComposerRowAvatar({ artist }: { artist: SubsonicArtist }) {
  const color = nameColor(artist.name);
  return (
    <div
      className="artist-avatar artist-avatar-initial"
      style={{ background: color, border: 0 }}
    >
      <span style={{ color: 'var(--ctp-crust)', fontWeight: 800 }}>{nameInitial(artist.name)}</span>
    </div>
  );
}

export default function Composers() {
  const perfFlags = usePerfProbeFlags();
  const { t } = useTranslation();
  const [composers, setComposers] = useState<SubsonicArtist[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<'unsupported' | 'transient' | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [filter, setFilter] = useState('');
  const [letterFilter, setLetterFilter] = useState(ALL_SENTINEL);
  const [starredOnly, setStarredOnly] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  // Compact tiles + initial-letter only → 200 per page is comfortable.
  const PAGE_SIZE = 200;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const observerTarget = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const openContextMenu = usePlayerStore(state => state.openContextMenu);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    // One large fetch — same shape as `getArtists()`. Server-side pagination is
    // an option but Symfonium-style classical libs rarely exceed a few thousand
    // composers, and a single round-trip beats N infinite-scroll calls when the
    // list is alphabetised + filtered locally.
    ndListArtistsByRole('composer', 0, 10000)
      .then(data => {
        if (cancelled) return;
        setComposers(data);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        const msg = String(err);
        console.warn('[psysonic] composers list failed:', err);
        // "Unsupported" only when the server explicitly rejects the request
        // shape. Network-layer errors (TLS handshake EOF, timeouts, 5xx) get
        // a retry button instead of a misleading "needs Navidrome 0.55+".
        const looksUnsupported = /\b(400|404|422|501)\b/.test(msg);
        setLoadError(looksUnsupported ? 'unsupported' : 'transient');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [musicLibraryFilterVersion, reloadTick]);

  const loadMore = useCallback(() => {
    if (loadingMore) return;
    setLoadingMore(true);
    setVisibleCount(prev => prev + PAGE_SIZE);
    setTimeout(() => setLoadingMore(false), 100);
  }, [loadingMore, PAGE_SIZE]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filter, letterFilter, starredOnly, viewMode, PAGE_SIZE]);

  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const filtered = useMemo(() => {
    let out = composers;
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
  }, [composers, letterFilter, filter, starredOnly, starredOverrides]);

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const hasMore = visibleCount < filtered.length;

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: '200px' }
    );
    if (observerTarget.current) observer.observe(observerTarget.current);
    return () => observer.disconnect();
  }, [loadMore, hasMore]);

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

  const composerListFlatRows = useMemo((): ComposerListFlatRow[] => {
    if (viewMode !== 'list') return [];
    const out: ComposerListFlatRow[] = [];
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
  const composerListOverscan = Math.max(
    12,
    Math.ceil(mainScrollViewportHeight / COMPOSER_LIST_ROW_EST),
  );

  const composerListVirtualizer = useVirtualizer({
    count:
      perfFlags.disableMainstageVirtualLists || viewMode !== 'list' ? 0 : composerListFlatRows.length,
    getScrollElement: () => document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID),
    estimateSize: index => {
      const row = composerListFlatRows[index];
      if (!row) return COMPOSER_LIST_ROW_EST;
      if (row.kind === 'letter') return COMPOSER_LIST_LETTER_ROW_EST;
      return row.isLastInLetter ? COMPOSER_LIST_LAST_IN_LETTER_EST : COMPOSER_LIST_ROW_EST;
    },
    getItemKey: index => {
      const row = composerListFlatRows[index];
      if (!row) return index;
      if (row.kind === 'letter') return `letter:${row.letter}`;
      return `composer:${row.artist.id}`;
    },
    overscan: composerListOverscan,
  });

  if (loadError) {
    return (
      <div className="content-body animate-fade-in">
        <div className="page-sticky-header">
          <h1 className="page-title">{t('composers.title')}</h1>
        </div>
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
          {loadError === 'unsupported' ? t('composers.unsupported') : t('composers.loadFailed')}
          {loadError === 'transient' && (
            <div style={{ marginTop: '1rem' }}>
              <button className="btn btn-surface" onClick={() => setReloadTick(t => t + 1)}>
                {t('composers.retry')}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="content-body animate-fade-in">
      <div className="page-sticky-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <h1 className="page-title" style={{ marginBottom: 0 }}>{t('composers.title')}</h1>
            <input
              className="input"
              style={{ maxWidth: 220 }}
              placeholder={t('composers.search')}
              value={filter}
              onChange={e => setFilter(e.target.value)}
              id="composer-filter-input"
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <StarFilterButton size="compact" active={starredOnly} onChange={setStarredOnly} />
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
        <div className="composer-grid-wrap">
          {visible.map(artist => (
            <div
              key={artist.id}
              className="composer-card"
              onClick={() => navigate(`/composer/${artist.id}`)}
              onContextMenu={(e) => {
                e.preventDefault();
                openContextMenu(e.clientX, e.clientY, artist, 'artist', undefined, undefined, undefined, 'composer');
              }}
            >
              <div className="composer-card-name">{artist.name}</div>
              {artist.albumCount != null && (
                <div className="composer-card-meta">
                  {t('composers.involvedIn', { count: artist.albumCount })}
                </div>
              )}
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
                      className="artist-row"
                      onClick={() => navigate(`/composer/${artist.id}`)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        openContextMenu(e.clientX, e.clientY, artist, 'artist', undefined, undefined, undefined, 'composer');
                      }}
                      id={`composer-${artist.id}`}
                    >
                      <ComposerRowAvatar artist={artist} />
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
                height: composerListFlatRows.length === 0 ? 0 : composerListVirtualizer.getTotalSize(),
                width: '100%',
                position: 'relative',
              }}
            >
              {composerListVirtualizer.getVirtualItems().map(vi => {
                const row = composerListFlatRows[vi.index];
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
                      className="artist-row"
                      onClick={() => navigate(`/composer/${artist.id}`)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        openContextMenu(e.clientX, e.clientY, artist, 'artist', undefined, undefined, undefined, 'composer');
                      }}
                      id={`composer-${artist.id}`}
                    >
                      <ComposerRowAvatar artist={artist} />
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
          {t('composers.notFound')}
        </div>
      )}
    </div>
  );
}
