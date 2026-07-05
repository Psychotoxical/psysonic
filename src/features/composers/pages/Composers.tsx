import type { SubsonicArtist } from '@/lib/api/subsonicTypes';
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ndListArtistsByRole } from '@/lib/api/navidromeBrowse';
import { LayoutGrid, List } from 'lucide-react';
import StarFilterButton from '@/ui/StarFilterButton';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { APP_MAIN_SCROLL_VIEWPORT_ID, COMPOSERS_INPAGE_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';
import { useElementClientHeightById, useElementClientHeightForElement } from '@/lib/hooks/useResizeClientHeight';
import { useMainstageInpageHeaderTight } from '@/lib/hooks/useMainstageInpageHeaderTight';
import { useBrowseArtistTextSearch } from '@/features/artist';
import { useComposersBrowseFilters, type ComposerBrowseScrollSnapshot } from '@/features/composers/hooks/useComposersBrowseFilters';
import { useComposersBrowseScrollRestore } from '@/features/composers/hooks/useComposersBrowseScrollRestore';
import { useArtistsBrowseScrollReset } from '@/features/artist';
import { useNavigateToComposer } from '@/features/composers/hooks/useNavigateToComposer';
import { peekComposerBrowseScrollRestore } from '@/features/composers/store/composerBrowseSessionStore';
import { useScopedBrowseSearchQuery } from '@/store/liveSearchScopeStore';
import { readComposerBrowseRestore } from '@/lib/navigation/albumDetailNavigation';
import { filterArtistsWithRoleAlbumCredits } from '@/lib/library/composerBrowse';
import { ALL_SENTINEL, artistLetterBucket } from '@/features/artist';
import { useLibraryIgnoredArticles } from '@/lib/library/hooks/useLibraryIgnoredArticles';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import { VirtualCardGrid } from '@/ui/VirtualCardGrid';
import OverlayScrollArea from '@/ui/OverlayScrollArea';
import { useVirtualizerScrollMargin } from '@/lib/hooks/useVirtualizerScrollMargin';
import { useClientSliceInfiniteScroll } from '@/lib/hooks/useClientSliceInfiniteScroll';
import { useInpageScrollViewport } from '@/lib/hooks/useInpageScrollViewport';
import InpageScrollSentinel from '@/ui/InpageScrollSentinel';

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
      <span style={{ color: 'var(--text-on-accent)', fontWeight: 800 }}>{nameInitial(artist.name)}</span>
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

  const scrollSnapshotRef = useRef<ComposerBrowseScrollSnapshot>({ scrollTop: 0, visibleCount: 0 });
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const restoreVisibleCountRef = useRef<number | undefined>(
    peekComposerBrowseScrollRestore(serverId)?.visibleCount,
  );

  const {
    letterFilter,
    setLetterFilter,
    starredOnly,
    setStarredOnly,
    viewMode,
    setViewMode,
  } = useComposersBrowseFilters(serverId, scrollSnapshotRef);

  const composersSearchQuery = useScopedBrowseSearchQuery('composers');

  // Full composer catalog is loaded via ndListArtistsByRole (Navidrome role stats,
  // correctly split multi-name credits). Generic artist index/search3 returns joined
  // performer strings — do not race that path on this page (report: zunoz, v1.47 RC3).
  const { textSearchLoading, effectiveFilter } = useBrowseArtistTextSearch(
    composersSearchQuery,
    false,
    serverId,
    'composers_browse',
  );
  const composerSource = composers;
  const textSearchActive = composersSearchQuery.trim().length > 0;
  const composerBrowsePlainLayout =
    perfFlags.disableMainstageVirtualLists
    || textSearchActive;

  // Compact tiles + initial-letter only → 200 per page is comfortable.
  const PAGE_SIZE = 200;
  const {
    scrollBodyRef,
    scrollBodyEl,
    bindScrollBody: bindComposersScrollBody,
    getScrollRoot,
  } = useInpageScrollViewport();
  const location = useLocation();
  const navigate = useNavigate();
  const navigateToComposer = useNavigateToComposer();
  const openContextMenu = usePlayerStore(state => state.openContextMenu);

  const {
    visibleCount,
    loadingMore,
    bindSentinel,
    loadMore: sliceLoadMore,
  } = useClientSliceInfiniteScroll({
    pageSize: PAGE_SIZE,
    resetDeps: [composersSearchQuery, letterFilter, starredOnly, viewMode, composerSource, serverId],
    getScrollRoot,
    scrollRootEl: scrollBodyEl,
    restoreDisplayCount: restoreVisibleCountRef.current,
  });

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
        setComposers(filterArtistsWithRoleAlbumCredits(data));
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

  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const ignoredArticles = useLibraryIgnoredArticles(serverId);
  const filtered = useMemo(() => {
    let out = composerSource;
    if (letterFilter !== ALL_SENTINEL) {
      out = out.filter(a => artistLetterBucket(a, ignoredArticles) === letterFilter);
    }
    if (effectiveFilter) {
      const needle = effectiveFilter.toLowerCase();
      out = out.filter(a => a.name.toLowerCase().includes(needle));
    }
    if (starredOnly) {
      out = out.filter(a => a.id in starredOverrides ? starredOverrides[a.id] : !!a.starred);
    }
    return out;
  }, [composerSource, letterFilter, effectiveFilter, starredOnly, starredOverrides, ignoredArticles]);

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const hasMore = visibleCount < filtered.length;

  scrollSnapshotRef.current = {
    scrollTop: scrollBodyEl?.scrollTop ?? 0,
    visibleCount,
  };

  const { isScrollRestorePending } = useComposersBrowseScrollRestore({
    serverId,
    scrollBodyEl,
    visibleCount,
    loading: loading || textSearchLoading,
    loadingMore,
    hasMore,
    loadMore: sliceLoadMore,
  });

  useEffect(() => {
    if (isScrollRestorePending || !readComposerBrowseRestore(location.state)) return;
    navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
  }, [isScrollRestorePending, location.pathname, location.search, location.hash, location.state, navigate]);

  const { groups, letters } = useMemo(() => {
    if (viewMode !== 'list') return { groups: {} as Record<string, SubsonicArtist[]>, letters: [] as string[] };
    const g: Record<string, SubsonicArtist[]> = {};
    for (const a of visible) {
      const key = artistLetterBucket(a, ignoredArticles);
      if (!g[key]) g[key] = [];
      g[key].push(a);
    }
    return { groups: g, letters: Object.keys(g).sort() };
  }, [visible, viewMode, ignoredArticles]);

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
  const composersInpageScrollHeight = useElementClientHeightForElement(
    scrollBodyEl,
    mainScrollViewportHeight,
  );

  const getInpageScrollElement = useCallback(
    () =>
      scrollBodyRef.current
      ?? (document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID) as HTMLElement | null),
    [scrollBodyRef],
  );

  const composerListOverscan = Math.max(
    12,
    Math.ceil(composersInpageScrollHeight / COMPOSER_LIST_ROW_EST),
  );

  const composerListWrapRef = useRef<HTMLDivElement>(null);
  const composerListScrollMargin = useVirtualizerScrollMargin(
    composerListWrapRef,
    getInpageScrollElement,
    {
      active: !composerBrowsePlainLayout && viewMode === 'list',
      deps: [composerListFlatRows.length],
    },
  );

  // React Compiler incompatible-library rule: third-party hook/value the compiler cannot analyze; usage is correct.
  // eslint-disable-next-line react-hooks/incompatible-library
  const composerListVirtualizer = useVirtualizer({
    count:
      composerBrowsePlainLayout || viewMode !== 'list' ? 0 : composerListFlatRows.length,
    getScrollElement: getInpageScrollElement,
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
    scrollMargin: composerListScrollMargin,
  });

  const mainstageHeaderTight = useMainstageInpageHeaderTight(scrollBodyEl, [
    composersSearchQuery,
    letterFilter,
    starredOnly,
    viewMode,
  ]);

  const browseScrollResetKey = [
    composersSearchQuery,
    letterFilter,
    starredOnly,
    viewMode,
    serverId,
    musicLibraryFilterVersion,
  ].join('\0');

  useArtistsBrowseScrollReset({
    scrollSnapshotRef,
    getScrollRoot,
    isScrollRestorePending,
    resetKey: browseScrollResetKey,
    viewMode,
    listVirtualize: !composerBrowsePlainLayout,
    listVirtualizer: composerListVirtualizer,
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
    <div className={`content-body animate-fade-in mainstage-inpage-split${mainstageHeaderTight ? ' mainstage-inpage--header-tight' : ''}`}>
      <div className="mainstage-inpage-toolbar">
        <div className="page-sticky-header">
          <div className="mainstage-inpage-toolbar-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <h1 className="page-title" style={{ marginBottom: 0 }}>{t('composers.title')}</h1>
              {textSearchLoading && (
                <div className="spinner" style={{ width: 16, height: 16, flexShrink: 0 }} />
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <StarFilterButton size="compact" active={starredOnly} onChange={setStarredOnly} />
              <button
                className={`btn btn-surface ${viewMode === 'grid' ? 'btn-sort-active' : ''}`}
                onClick={() => setViewMode('grid')}
                style={viewMode === 'grid' ? { background: 'var(--accent)', color: 'var(--text-on-accent)', padding: '0.5rem' } : { padding: '0.5rem' }}
                data-tooltip={t('artists.gridView')}
              >
                <LayoutGrid size={20} />
              </button>
              <button
                className={`btn btn-surface ${viewMode === 'list' ? 'btn-sort-active' : ''}`}
                onClick={() => setViewMode('list')}
                style={viewMode === 'list' ? { background: 'var(--accent)', color: 'var(--text-on-accent)', padding: '0.5rem' } : { padding: '0.5rem' }}
                data-tooltip={t('artists.listView')}
              >
                <List size={20} />
              </button>
            </div>
          </div>

          <div className="mainstage-inpage-toolbar-alpha-row">
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
      </div>

      <OverlayScrollArea
        className="mainstage-inpage-scroll"
        viewportClassName="mainstage-inpage-scroll__viewport"
        viewportId={COMPOSERS_INPAGE_SCROLL_VIEWPORT_ID}
        viewportRef={bindComposersScrollBody}
        railInset="panel"
        measureDeps={[
          loading,
          viewMode,
          visible.length,
          composerListFlatRows.length,
          filtered.length,
          hasMore,
        ]}
      >
        {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}><div className="spinner" /></div>}

        {!loading && viewMode === 'grid' && (
          <VirtualCardGrid
            items={visible}
            itemKey={(a, _i) => a.id}
            rowVariant="composer"
            disableVirtualization={composerBrowsePlainLayout}
            layoutSignal={visible.length}
            wrapClassName="composer-grid-wrap"
            gridGap="var(--space-2)"
            scrollRootId={COMPOSERS_INPAGE_SCROLL_VIEWPORT_ID}
            renderItem={artist => (
              <div
                className="composer-card"
                onClick={() => navigateToComposer(artist.id)}
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
            )}
          />
        )}

        {!loading && viewMode === 'list' && (
          composerBrowsePlainLayout ? (
            <>
              {letters.map(letter => (
                <div key={letter} style={{ marginBottom: '1.5rem' }}>
                  <h3 className="letter-heading">{letter}</h3>
                  <div className="artist-list">
                    {groups[letter].map(artist => (
                      <button
                        key={artist.id}
                        className="artist-row"
                        onClick={() => navigateToComposer(artist.id)}
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
            <div ref={composerListWrapRef} style={{ position: 'relative', width: '100%' }}>
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
                          transform: `translateY(${vi.start - composerListScrollMargin}px)`,
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
                        transform: `translateY(${vi.start - composerListScrollMargin}px)`,
                        paddingBottom: row.isLastInLetter ? '1.5rem' : undefined,
                      }}
                    >
                      <button
                        type="button"
                        className="artist-row"
                        onClick={() => navigateToComposer(artist.id)}
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
          <InpageScrollSentinel bindSentinel={bindSentinel} loading={loadingMore} />
        )}

        {!loading && filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
            {t('composers.notFound')}
          </div>
        )}
      </OverlayScrollArea>
    </div>
  );
}
