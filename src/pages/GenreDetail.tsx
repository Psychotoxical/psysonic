import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Disc3, Play, ListPlus, Loader2 } from 'lucide-react';
import AlbumCard from '../components/AlbumCard';
import { LongPressWaveOverlay } from '../components/LongPressWaveOverlay';
import InpageScrollSentinel from '../components/InpageScrollSentinel';
import OverlayScrollArea from '../components/OverlayScrollArea';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import { GENRE_DETAIL_INPAGE_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import { albumGridWarmCovers } from '../cover/layoutSizes';
import { useAlbumBrowseScrollSnapshotSync, type AlbumBrowseScrollSnapshot } from '../hooks/useAlbumBrowseFilters';
import { useGenreAlbumBrowse } from '../hooks/useGenreAlbumBrowse';
import { useAlbumBrowseScrollRestore } from '../hooks/useAlbumBrowseScrollRestore';
import { useGenreDetailBrowse } from '../hooks/useGenreDetailBrowse';
import { useInpageScrollViewport } from '../hooks/useInpageScrollViewport';
import { useLongPressAction } from '../hooks/useLongPressAction';
import { useMainstageInpageHeaderTight } from '../hooks/useMainstageInpageHeaderTight';
import { useAuthStore } from '../store/authStore';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import { usePlayerStore } from '../store/playerStore';
import {
  fetchGenreAlbumCount,
  fetchGenreTracksForPlayback,
} from '../utils/library/genreBrowsePlayback';
import { lookupGenreAlbumCount } from '../utils/library/genreCatalogCountsCache';
import { libraryScopeForServer } from '../api/subsonicClient';
import {
  readAlbumBrowseRestore,
  readAlbumDetailReturnTo,
} from '../utils/navigation/albumDetailNavigation';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { runBulkEnqueue, runBulkPlayAll, runBulkShuffle } from '../utils/playback/runBulkPlay';

export default function GenreDetail() {
  const { name } = useParams<{ name: string }>();
  const genre = decodeURIComponent(name ?? '');
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const navigate = useNavigate();
  const location = useLocation();
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(serverId));
  const playTrack = usePlayerStore(s => s.playTrack);
  const enqueue = usePlayerStore(s => s.enqueue);

  const scrollSnapshotRef = useRef<AlbumBrowseScrollSnapshot>({ scrollTop: 0, displayCount: 0 });

  const { sort, restoreDisplayCount } = useGenreDetailBrowse(serverId, genre, scrollSnapshotRef);

  const {
    scrollBodyEl,
    bindScrollBody: bindGenreDetailScrollBody,
    getScrollRoot,
  } = useInpageScrollViewport();

  const {
    albums,
    loading,
    loadingMore,
    hasMore,
    displayAlbums,
    bindLoadMoreSentinel,
    loadMore,
  } = useGenreAlbumBrowse(
    serverId,
    genre,
    indexEnabled,
    sort,
    musicLibraryFilterVersion,
    getScrollRoot,
    scrollBodyEl,
    restoreDisplayCount,
  );

  useAlbumBrowseScrollSnapshotSync(scrollSnapshotRef, scrollBodyEl, displayAlbums.length);

  const { isScrollRestorePending } = useAlbumBrowseScrollRestore({
    serverId,
    genreName: genre,
    scrollBodyEl,
    displayAlbumsLength: displayAlbums.length,
    loading,
    loadingMore,
    hasMore,
    loadMore,
  });

  useEffect(() => {
    if (isScrollRestorePending || !readAlbumBrowseRestore(location.state)) return;
    navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
  }, [isScrollRestorePending, location.pathname, location.search, location.hash, location.state, navigate]);

  const [albumCount, setAlbumCount] = useState<number | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);

  useEffect(() => {
    if (!genre || !serverId) return;
    const cached = lookupGenreAlbumCount(serverId, genre, libraryScopeForServer(serverId));
    // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (cached != null) setAlbumCount(cached);
  }, [serverId, genre, musicLibraryFilterVersion]);

  useEffect(() => {
    if (!genre || loading) return;
    const cached = lookupGenreAlbumCount(serverId, genre, libraryScopeForServer(serverId));
    if (cached != null) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchGenreAlbumCount(serverId, genre, indexEnabled, sort).then(count => {
        if (!cancelled) setAlbumCount(count);
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [serverId, genre, indexEnabled, sort, musicLibraryFilterVersion, loading]);

  const fetchGenreTracks = useCallback(
    (shuffle?: boolean) => fetchGenreTracksForPlayback(serverId, genre, {
      shuffle,
      indexEnabled,
    }),
    [serverId, genre, indexEnabled],
  );

  const handlePlayAll = useCallback(
    () => runBulkPlayAll({ fetchTracks: () => fetchGenreTracks(false), setLoading: setBulkLoading, playTrack }),
    [fetchGenreTracks, playTrack],
  );
  const handleShuffleAll = useCallback(
    () => runBulkShuffle({ fetchTracks: () => fetchGenreTracks(true), setLoading: setBulkLoading, playTrack }),
    [fetchGenreTracks, playTrack],
  );
  const handleEnqueueAll = useCallback(
    () => runBulkEnqueue({ fetchTracks: () => fetchGenreTracks(false), setLoading: setBulkLoading, enqueue }),
    [fetchGenreTracks, enqueue],
  );

  const { isHolding, pressBind } = useLongPressAction({
    onShortPress: handlePlayAll,
    onLongPress: handleShuffleAll,
  });

  const handleBack = useCallback(() => {
    navigate(readAlbumDetailReturnTo(location.state) ?? '/genres');
  }, [navigate, location.state]);

  const mainstageHeaderTight = useMainstageInpageHeaderTight(scrollBodyEl, [genre, albumCount, bulkLoading]);

  const headerCount = useMemo(() => {
    if (!loading && !hasMore && albums.length > 0) return albums.length;
    if (albumCount != null) return albumCount;
    if (loading) return null;
    return displayAlbums.length > 0 ? displayAlbums.length : null;
  }, [loading, hasMore, albums.length, albumCount, displayAlbums.length]);
  const showPlayback = !loading && (displayAlbums.length > 0 || (albumCount ?? 0) > 0);

  return (
    <div className={`content-body animate-fade-in mainstage-inpage-split${mainstageHeaderTight ? ' mainstage-inpage--header-tight' : ''}`}>
      <div className="mainstage-inpage-toolbar">
        <div className="page-sticky-header mainstage-inpage-toolbar-row">
          <button
            className="btn btn-ghost"
            onClick={handleBack}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginRight: '0.25rem' }}
          >
            <ArrowLeft size={16} />
            <span>{t('genres.back')}</span>
          </button>
          <h1 className="page-title" style={{ marginBottom: 0 }}>{genre}</h1>
          {headerCount != null && headerCount > 0 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.9rem', fontWeight: 500 }}>
              <Disc3 size={14} style={{ color: 'var(--accent)' }} />
              {t('genres.albumCount', { count: headerCount })}
            </span>
          )}
          {showPlayback && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: 'auto' }}>
              <button
                type="button"
                className="btn btn-primary long-press-play-btn"
                {...pressBind}
                disabled={bulkLoading}
                data-tooltip={t('genres.playTooltip')}
              >
                <LongPressWaveOverlay active={isHolding} size="compact" />
                <span className="long-press-play-btn__icon" style={{ gap: '0.35rem' }}>
                  {bulkLoading ? <Loader2 size={15} className="spin" /> : <Play size={15} fill="currentColor" />}
                  {t('common.play')}
                </span>
              </button>
              <button
                className="btn btn-surface"
                onClick={handleEnqueueAll}
                disabled={bulkLoading}
                data-tooltip={t('genres.addToQueue')}
              >
                <ListPlus size={16} />
              </button>
            </div>
          )}
        </div>
      </div>

      <OverlayScrollArea
        className="mainstage-inpage-scroll"
        viewportClassName="mainstage-inpage-scroll__viewport"
        viewportId={GENRE_DETAIL_INPAGE_SCROLL_VIEWPORT_ID}
        viewportRef={bindGenreDetailScrollBody}
        railInset="panel"
        measureDeps={[
          loading,
          displayAlbums.length,
          hasMore,
          genre,
          perfFlags.disableMainstageVirtualLists,
        ]}
      >
        {loading && albums.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
            <div className="spinner" />
          </div>
        ) : !loading && displayAlbums.length === 0 ? (
          <p className="loading-text" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
            {t('genres.albumsEmpty')}
          </p>
        ) : (
          <div style={{ position: 'relative' }}>
            <div style={{ visibility: isScrollRestorePending ? 'hidden' : 'visible' }}>
              <VirtualCardGrid
                items={displayAlbums}
                itemKey={(a, _i) => a.id}
                rowVariant="album"
                disableVirtualization={perfFlags.disableMainstageVirtualLists}
                layoutSignal={displayAlbums.length}
                scrollRootId={GENRE_DETAIL_INPAGE_SCROLL_VIEWPORT_ID}
                warmGridCovers={albumGridWarmCovers()}
                renderItem={album => (
                  <AlbumCard
                    album={album}
                    observeScrollRootId={GENRE_DETAIL_INPAGE_SCROLL_VIEWPORT_ID}
                  />
                )}
              />
              {hasMore && (
                <InpageScrollSentinel bindSentinel={bindLoadMoreSentinel} loading={loadingMore} />
              )}
            </div>
            {isScrollRestorePending && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  justifyContent: 'center',
                  paddingTop: '3rem',
                  background: 'var(--bg-app)',
                }}
              >
                <div className="spinner" />
              </div>
            )}
          </div>
        )}
      </OverlayScrollArea>
    </div>
  );
}
