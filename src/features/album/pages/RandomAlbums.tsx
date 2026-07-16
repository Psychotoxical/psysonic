import { buildDownloadUrl } from '@/lib/api/subsonicStreamUrl';
import { getAlbumsByGenre } from '@/lib/api/subsonicGenres';
import { getAlbumList } from '@/lib/api/subsonicLibrary';
import { resolveAlbum } from '@/features/offline';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { dedupeById } from '@/lib/util/dedupeById';
import { shuffleArray } from '@/lib/util/shuffleArray';
import React, { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import { RefreshCw, Download, HardDriveDownload } from 'lucide-react';
import SelectionToggleButton from '@/ui/SelectionToggleButton';
import AlbumCard from '@/features/album/components/AlbumCard';
import GenreFilterBar from '@/ui/GenreFilterBar';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { filterAlbumsByMixRatings, getMixMinRatingsConfigFromAuth } from '@/features/playback/utils/mixRatingFilter';
import { runLocalRandomAlbums, runLocalAlbumsByGenres } from '@/lib/library/browseTextSearch';
import { useOfflineStore } from '@/features/offline';
import { useDownloadModalStore } from '@/features/offline';
import { downloadZip } from '@/lib/api/downloadZip';
import { join } from '@tauri-apps/api/path';
import { showToast } from '@/lib/dom/toast';
import { useZipDownloadStore } from '@/features/offline';
import { useRangeSelection } from '@/lib/hooks/useRangeSelection';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import { albumGridWarmCovers, COVER_DENSE_GRID_MIN_CELL_CSS_PX } from '@/cover/layoutSizes';
import {
  primeAlbumCoversForDisplay,
} from '@/cover/warmDiskPeek';
import { VirtualCardGrid } from '@/ui/VirtualCardGrid';
import OverlayScrollArea from '@/ui/OverlayScrollArea';
import { RANDOM_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';
import { useMainstageInpageHeaderTight } from '@/lib/hooks/useMainstageInpageHeaderTight';
import { useInpageScrollViewport } from '@/lib/hooks/useInpageScrollViewport';
import { useAlbumGridBrowseFilters, type AlbumGridBrowseSnapshot } from '@/features/album/hooks/useAlbumGridBrowseFilters';
import { useAlbumBrowseScrollRestore } from '@/features/album/hooks/useAlbumBrowseScrollRestore';
import { useAlbumBrowseScrollSnapshotSync, type AlbumBrowseScrollSnapshot } from '@/features/album/hooks/useAlbumBrowseFilters';
import { readAlbumBrowseRestore } from '@/lib/navigation/albumDetailNavigation';
import { albumArtistDisplayName } from '@/features/album/utils/deriveAlbumHeaderArtistRefs';

const ALBUM_COUNT = 30;
/** Extra pool when mix rating filter is on so we can still fill the grid after filtering. */
const ALBUM_FETCH_OVERSHOOT = 100;
/** Cap genre-union size before rating prefetch (avoids hundreds of `getArtist` calls). */
const GENRE_UNION_PREFILTER_CAP = 250;

function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: strip control chars for safe download filenames
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'download';
}

async function fetchByGenres(genres: string[]): Promise<SubsonicAlbum[]> {
  const results = await Promise.all(genres.map(g => getAlbumsByGenre(g, 500, 0)));
  const pool = shuffleArray(dedupeById(results.flat())).slice(0, GENRE_UNION_PREFILTER_CAP);
  const filtered = await filterAlbumsByMixRatings(pool, getMixMinRatingsConfigFromAuth());
  return filtered.slice(0, ALBUM_COUNT);
}

/** Shared fetch logic — used by both `load` and the background reserve fill. */
async function doFetchRandomAlbums(genres: string[]): Promise<SubsonicAlbum[]> {
  const mixCfg = getMixMinRatingsConfigFromAuth();
  const albumMixActive = mixCfg.enabled && (mixCfg.minAlbum > 0 || mixCfg.minArtist > 0);
  const randomSize = albumMixActive ? Math.max(ALBUM_COUNT * 3, ALBUM_FETCH_OVERSHOOT) : ALBUM_COUNT;

  const serverId = useAuthStore.getState().activeServerId ?? '';
  const indexEnabled = useLibraryIndexStore.getState().isIndexEnabled(serverId);

  if (genres.length === 0 && indexEnabled && serverId) {
    // Local path: SQLite ORDER BY RANDOM() LIMIT N — no network, effectively instant.
    const local = await runLocalRandomAlbums(serverId, randomSize);
    if (local && local.length > 0) {
      return (await filterAlbumsByMixRatings(local, mixCfg)).slice(0, ALBUM_COUNT);
    }
  }

  if (genres.length > 0 && indexEnabled && serverId) {
    // Genre path: local index union + JS shuffle (avoids per-genre network requests).
    const allLocal = await runLocalAlbumsByGenres(serverId, genres, 'alphabeticalByName', GENRE_UNION_PREFILTER_CAP);
    if (allLocal && allLocal.length > 0) {
      const pool = shuffleArray(dedupeById(allLocal)).slice(0, GENRE_UNION_PREFILTER_CAP);
      return (await filterAlbumsByMixRatings(pool, mixCfg)).slice(0, ALBUM_COUNT);
    }
  }

  // Network fallback when local index is unavailable or returned nothing.
  return genres.length > 0
    ? fetchByGenres(genres)
    : (await filterAlbumsByMixRatings(await getAlbumList('random', randomSize), mixCfg)).slice(0, ALBUM_COUNT);
}

// ── Module-level reserve: next batch pre-fetched after each Refresh ──────────
type AlbumReserve = { filterId: string; albums: SubsonicAlbum[] };
let _nextReserve: AlbumReserve | null = null;
let _reserveFilling = false;

function makeFilterId(
  libraryVersion: number,
  mixEnabled: boolean,
  minAlbum: number,
  minArtist: number,
  genres: string[],
): string {
  return `${libraryVersion}:${mixEnabled}:${minAlbum}:${minArtist}:${genres.join('\x01')}`;
}

/** Consume the pre-fetched reserve if the filter matches, otherwise discard it. */
function takeReserve(filterId: string): SubsonicAlbum[] | null {
  if (_nextReserve?.filterId === filterId) {
    const albums = _nextReserve.albums;
    _nextReserve = null;
    return albums;
  }
  _nextReserve = null;
  return null;
}

/**
 * Fire-and-forget: fetch the next batch in the background so it's ready for
 * the next Refresh. Covers are NOT pre-warmed here — doing so would call
 * bumpDiskSrcCache() for every reserve cover, which re-renders all useCoverArt
 * subscribers on the current page and causes a visible flash ~1.5 s after load.
 * Covers are warmed lazily via primeAlbumCoversForDisplay when the reserve is
 * actually consumed.
 */
async function fillReserve(filterId: string, genres: string[]): Promise<void> {
  if (_reserveFilling) return;
  _reserveFilling = true;
  try {
    const albums = await doFetchRandomAlbums(genres);
    _nextReserve = { filterId, albums };
  } catch {
    // Network or cache failure — next Refresh falls back to a fresh fetch.
  } finally {
    _reserveFilling = false;
  }
}

export default function RandomAlbums() {
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const auth = useAuthStore();
  const musicLibraryFilterVersion = auth.musicLibraryFilterVersion;
  const mixMinRatingFilterEnabled = auth.mixMinRatingFilterEnabled;
  const mixMinRatingAlbum = auth.mixMinRatingAlbum;
  const mixMinRatingArtist = auth.mixMinRatingArtist;
  const serverId = auth.activeServerId ?? '';
  const downloadAlbum = useOfflineStore(s => s.downloadAlbum);
  const requestDownloadFolder = useDownloadModalStore(s => s.requestFolder);
  const navigate = useNavigate();
  const location = useLocation();

  const scrollSnapshotRef = useRef<AlbumBrowseScrollSnapshot>({ scrollTop: 0, displayCount: 0 });
  const gridSnapshotRef = useRef<AlbumGridBrowseSnapshot>({ albums: [], hasMore: false });
  const {
    selectedGenres,
    setSelectedGenres,
    initialAlbums,
  } = useAlbumGridBrowseFilters(serverId, 'random-albums', scrollSnapshotRef, gridSnapshotRef);
  const restoringSessionRef = useRef(initialAlbums != null);

  const [albums, setAlbums] = useState<SubsonicAlbum[]>(() => initialAlbums ?? []);
  const [loading, setLoading] = useState(() => initialAlbums == null);
  const loadingRef = useRef(false);
  const filtered = selectedGenres.length > 0;
  const {
    scrollBodyEl,
    bindScrollBody: bindRandomAlbumsScrollBody,
  } = useInpageScrollViewport();

  const [selectionMode, setSelectionMode] = useState(false);
  const { selectedIds, toggleSelect, clearSelection: resetSelection } = useRangeSelection(albums);

  const toggleSelectionMode = () => { setSelectionMode(v => !v); resetSelection(); };
  const clearSelection = () => { setSelectionMode(false); resetSelection(); };
  const selectedAlbums = albums.filter(a => selectedIds.has(a.id));

  const handleDownloadZips = async () => {
    if (selectedAlbums.length === 0) return;
    const folder = auth.downloadFolder || await requestDownloadFolder();
    if (!folder) return;
    const { start, complete, fail } = useZipDownloadStore.getState();
    clearSelection();
    for (const album of selectedAlbums) {
      const downloadId = crypto.randomUUID();
      const filename = `${sanitizeFilename(album.name)}.zip`;
      const destPath = await join(folder, filename);
      const url = buildDownloadUrl(album.id);
      start(downloadId, filename);
      try {
        await downloadZip({ id: downloadId, url, destPath });
        complete(downloadId);
      } catch (e) {
        fail(downloadId);
        console.error('ZIP download failed for', album.name, e);
        showToast(t('albums.downloadZipFailed', { name: album.name }), 4000, 'error');
      }
    }
  };

  const handleAddOffline = async () => {
    if (selectedAlbums.length === 0) return;
    let queued = 0;
    for (const album of selectedAlbums) {
      try {
        const detail = await resolveAlbum(serverId, album.id);
        if (!detail) throw new Error('album unavailable');
        downloadAlbum(album.id, album.name, albumArtistDisplayName(album), album.coverArt, album.year, detail.songs, serverId);
        queued++;
      } catch {
        showToast(t('albums.offlineFailed', { name: album.name }), 3000, 'error');
      }
    }
    if (queued > 0) showToast(t('albums.offlineQueuing', { count: queued }), 3000, 'info');
    clearSelection();
  };

  const load = useCallback(async (genres: string[]) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const filterId = makeFilterId(
        musicLibraryFilterVersion, mixMinRatingFilterEnabled,
        mixMinRatingAlbum, mixMinRatingArtist, genres,
      );
      const reserved = takeReserve(filterId);
      if (reserved) {
        await primeAlbumCoversForDisplay(reserved, COVER_DENSE_GRID_MIN_CELL_CSS_PX);
        setAlbums(reserved);
      } else {
        const data = await doFetchRandomAlbums(genres);
        await primeAlbumCoversForDisplay(data, COVER_DENSE_GRID_MIN_CELL_CSS_PX);
        setAlbums(data);
      }
      // Pre-fetch + disk-warm the next batch so the next Refresh is instant.
      void fillReserve(filterId, genres);
    } catch (e) {
      console.error(e);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [
    musicLibraryFilterVersion,
    mixMinRatingFilterEnabled,
    mixMinRatingAlbum,
    mixMinRatingArtist,
  ]);

  const loadRef = useRef(load);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  loadRef.current = load;
  useEffect(() => {
    if (restoringSessionRef.current) return;
    loadRef.current(selectedGenres);
  }, [selectedGenres]);

  // React Compiler immutability rule: intentional imperative mutation of an external/DOM target inside an effect.
  // eslint-disable-next-line react-hooks/immutability
  const handleRefresh = useCallback(() => {
    if (scrollBodyEl) {
      // React Compiler immutability rule: intentional imperative mutation of an external/DOM target inside an effect.
      // eslint-disable-next-line react-hooks/immutability
      scrollBodyEl.scrollTop = 0;
      scrollBodyEl.dispatchEvent(new Event('scroll', { bubbles: false }));
    }
    scrollSnapshotRef.current.scrollTop = 0;
    load(selectedGenres);
  }, [scrollBodyEl, load, selectedGenres]);

  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  gridSnapshotRef.current = { albums, hasMore: false };
  useAlbumBrowseScrollSnapshotSync(scrollSnapshotRef, scrollBodyEl, albums.length);

  const { isScrollRestorePending } = useAlbumBrowseScrollRestore({
    serverId,
    surface: 'random-albums',
    scrollBodyEl,
    displayAlbumsLength: albums.length,
    loading,
    loadingMore: false,
    hasMore: false,
    loadMore: () => {},
  });

  useLayoutEffect(() => {
    if (!isScrollRestorePending && restoringSessionRef.current) {
      restoringSessionRef.current = false;
    }
  }, [isScrollRestorePending]);

  useEffect(() => {
    if (isScrollRestorePending || !readAlbumBrowseRestore(location.state)) return;
    navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
  }, [isScrollRestorePending, location.pathname, location.search, location.hash, location.state, navigate]);

  const mainstageHeaderTight = useMainstageInpageHeaderTight(scrollBodyEl, [
    filtered,
    selectionMode,
    selectedGenres,
  ]);

  return (
    <div className={`content-body animate-fade-in mainstage-inpage-split${mainstageHeaderTight ? ' mainstage-inpage--header-tight' : ''}`}>
      <div className="mainstage-inpage-toolbar">
        <div className="page-sticky-header mainstage-inpage-toolbar-row">
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            {selectionMode && selectedIds.size > 0
              ? t('albums.selectionCount', { count: selectedIds.size })
              : t('randomAlbums.title')}
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            {selectionMode && selectedIds.size > 0 ? (
              <>
                <button className="btn btn-surface albums-selection-action-btn" onClick={handleAddOffline} aria-label={t('albums.addOffline')} data-tooltip={t('albums.addOffline')}>
                  <HardDriveDownload size={15} />
                  <span className="toolbar-btn-label">{t('albums.addOffline')}</span>
                </button>
                <button className="btn btn-surface albums-selection-action-btn" onClick={handleDownloadZips} aria-label={t('albums.downloadZips')} data-tooltip={t('albums.downloadZips')}>
                  <Download size={15} />
                  <span className="toolbar-btn-label">{t('albums.downloadZips')}</span>
                </button>
              </>
            ) : (
              <>
                <GenreFilterBar selected={selectedGenres} onSelectionChange={setSelectedGenres} />
                <button
                  className="btn btn-surface"
                  onClick={handleRefresh}
                  disabled={loading}
                  aria-label={t('randomAlbums.refresh')}
                  data-tooltip={t('randomAlbums.refresh')}
                >
                  <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
                  <span className="toolbar-btn-label">{t('randomAlbums.refresh')}</span>
                </button>
              </>
            )}
            <SelectionToggleButton
              active={selectionMode}
              onToggle={toggleSelectionMode}
              selectLabel={t('albums.select')}
              cancelLabel={t('albums.cancelSelect')}
              startTooltip={t('albums.startSelect')}
            />
          </div>
        </div>
      </div>

      <OverlayScrollArea
        className="mainstage-inpage-scroll"
        viewportClassName="mainstage-inpage-scroll__viewport"
        viewportId={RANDOM_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID}
        viewportRef={bindRandomAlbumsScrollBody}
        railInset="panel"
        measureDeps={[
          loading,
          albums.length,
          filtered,
          selectionMode,
          perfFlags.disableMainstageVirtualLists,
        ]}
      >
        {loading && albums.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
            <div className="spinner" />
          </div>
        ) : !loading && albums.length === 0 ? (
          <div className="empty-state" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
            {t('common.libraryEmpty')}
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <div style={{ visibility: isScrollRestorePending ? 'hidden' : 'visible' }}>
              <VirtualCardGrid
                items={albums}
                itemKey={(a, _i) => a.id}
                rowVariant="album"
                disableVirtualization={perfFlags.disableMainstageVirtualLists}
                layoutSignal={albums.length}
                scrollRootId={RANDOM_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID}
                warmGridCovers={albumGridWarmCovers()}
                renderItem={a => (
                  <AlbumCard
                    album={a}
                    observeScrollRootId={RANDOM_ALBUMS_INPAGE_SCROLL_VIEWPORT_ID}
                    selectionMode={selectionMode}
                    selected={selectedIds.has(a.id)}
                    onToggleSelect={toggleSelect}
                    selectedAlbums={selectedAlbums}
                    ensurePriority="high"
                  />
                )}
              />
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
