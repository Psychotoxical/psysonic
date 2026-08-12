import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Play, ListPlus, Loader2 } from 'lucide-react';
import { AlbumCard } from '@/features/album';
import { LongPressWaveOverlay } from '@/ui/LongPressWaveOverlay';
import InpageScrollSentinel from '@/ui/InpageScrollSentinel';
import OverlayScrollArea from '@/ui/OverlayScrollArea';
import { VirtualCardGrid } from '@/ui/VirtualCardGrid';
import { GENRE_DETAIL_INPAGE_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';
import { albumGridWarmCovers } from '@/cover/layoutSizes';
import { useAlbumBrowseScrollSnapshotSync, type AlbumBrowseScrollSnapshot } from '@/features/album';
import { useGenreAlbumBrowse } from '@/features/album';
import { useAlbumBrowseScrollRestore } from '@/features/album';
import { useGenreDetailBrowse } from '@/features/genre/hooks/useGenreDetailBrowse';
import { useInpageScrollViewport } from '@/lib/hooks/useInpageScrollViewport';
import { useLongPressAction } from '@/lib/hooks/useLongPressAction';
import { useMainstageInpageHeaderTight } from '@/lib/hooks/useMainstageInpageHeaderTight';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import {
  fetchGenreAlbumCount,
  fetchGenreTracksForPlayback,
  lookupScopedGenreAlbumCount,
} from '@/features/playback/utils/playback/genreBrowsePlayback';
import { lookupGenreAlbumCount } from '@/lib/library/genreCatalogCountsCache';
import { libraryScopeCacheKeyForServer } from '@/lib/api/subsonicClient';
import {
  readAlbumBrowseRestore,
  readAlbumDetailReturnTo,
} from '@/lib/navigation/albumDetailNavigation';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import { runBulkEnqueue, runBulkPlayAll, runBulkShuffle } from '@/features/playback/utils/playback/runBulkPlay';
import { deriveLibraryBrowseScope } from '@/lib/library/libraryBrowseScope';
import { useUnavailableServerIds } from '@/lib/network/serverReachability';
import { resolveGenreHeaderCount } from './genreHeaderCount';

export default function GenreDetail() {
  const { name } = useParams<{ name: string }>();
  const genre = decodeURIComponent(name ?? '');
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const navigate = useNavigate();
  const location = useLocation();
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const activeServerId = useAuthStore(s => s.activeServerId ?? '');
  const servers = useAuthStore(s => s.servers);
  const libraryBrowseServerIds = useAuthStore(s => s.libraryBrowseServerIds);
  const musicFoldersByServer = useAuthStore(s => s.musicFoldersByServer);
  const libraryBrowseSelectionByServer = useAuthStore(s => s.libraryBrowseSelectionByServer);
  const unavailableServerIds = useUnavailableServerIds();
  const browseScope = useMemo(
    () => deriveLibraryBrowseScope({
      servers,
      activeServerId: activeServerId || null,
      libraryBrowseServerIds,
      musicFoldersByServer,
      libraryBrowseSelectionByServer,
    }, unavailableServerIds),
    [
      activeServerId,
      libraryBrowseSelectionByServer,
      libraryBrowseServerIds,
      musicFoldersByServer,
      servers,
      unavailableServerIds,
    ],
  );
  const serverId = browseScope.anchorServerId ?? activeServerId;
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
    browseScope,
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
    const cached = lookupScopedGenreAlbumCount(browseScope, genre)
      ?? lookupGenreAlbumCount(serverId, genre, libraryScopeCacheKeyForServer(serverId));
    // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAlbumCount(cached);
  }, [serverId, genre, musicLibraryFilterVersion, browseScope]);

  useEffect(() => {
    if (!genre || loading || !hasMore) return;
    const cached = lookupScopedGenreAlbumCount(browseScope, genre)
      ?? lookupGenreAlbumCount(serverId, genre, libraryScopeCacheKeyForServer(serverId));
    if (cached != null && !browseScope.multiServer) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchGenreAlbumCount(serverId, genre, indexEnabled, sort, browseScope).then(count => {
        if (!cancelled) setAlbumCount(count);
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [serverId, genre, indexEnabled, sort, musicLibraryFilterVersion, browseScope, loading, hasMore]);

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
    return resolveGenreHeaderCount({
      loading,
      hasMore,
      loadedAlbumCount: albums.length,
      albumCount,
    });
  }, [loading, hasMore, albums.length, albumCount]);
  const showPlayback = !loading && (displayAlbums.length > 0 || (albumCount ?? 0) > 0);

  return (
    <div className={`content-body animate-fade-in mainstage-inpage-split${mainstageHeaderTight ? ' mainstage-inpage--header-tight' : ''}`}>
      <div className="mainstage-inpage-toolbar">
        <div className="page-sticky-header mainstage-inpage-toolbar-row">
          <button
            className="btn btn-ghost"
            onClick={handleBack}
            aria-label={t('genres.back')}
            data-tooltip={t('genres.back')}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginRight: '0.25rem' }}
          >
            <ArrowLeft size={16} />
            <span className="toolbar-btn-label">{t('genres.back')}</span>
          </button>
          <div className="psy-page-heading psy-page-heading--fill">
            <h1 className="page-title truncate" title={genre}>{genre}</h1>
            {headerCount != null && headerCount > 0 && (
              <span className="psy-page-heading__count">
                <span aria-hidden="true">–</span>
                {t('genres.albumCount', { count: headerCount })}
              </span>
            )}
          </div>
          {showPlayback && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: 'auto' }}>
              <button
                type="button"
                className="btn btn-primary long-press-play-btn"
                {...pressBind}
                disabled={bulkLoading}
                aria-label={t('genres.playTooltip')}
                data-tooltip={t('genres.playTooltip')}
              >
                <LongPressWaveOverlay active={isHolding} size="compact" />
                <span className="long-press-play-btn__icon" style={{ gap: '0.35rem' }}>
                  {bulkLoading ? <Loader2 size={15} className="spin" /> : <Play size={15} fill="currentColor" />}
                  <span className="toolbar-btn-label">{t('common.play')}</span>
                </span>
              </button>
              {/* Stretch instead of a fixed height: this button holds only an
                  icon, so its content box is shorter than the play button's
                  text line and it would otherwise sit smaller beside it. */}
              <button
                className="btn btn-surface"
                style={{ alignSelf: 'stretch' }}
                onClick={handleEnqueueAll}
                disabled={bulkLoading}
                aria-label={t('genres.addToQueue')}
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
                <InpageScrollSentinel
                  bindSentinel={bindLoadMoreSentinel}
                  loading={loadingMore}
                  itemCount={displayAlbums.length}
                />
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
