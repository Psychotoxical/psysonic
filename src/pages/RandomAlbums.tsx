import { buildDownloadUrl } from '../api/subsonicStreamUrl';
import { getAlbumsByGenre } from '../api/subsonicGenres';
import { getAlbumList, getAlbum } from '../api/subsonicLibrary';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { dedupeById } from '../utils/dedupeById';
import { shuffleArray } from '../utils/playback/shuffleArray';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { RefreshCw, CheckSquare2, Download, HardDriveDownload } from 'lucide-react';
import AlbumCard from '../components/AlbumCard';
import GenreFilterBar from '../components/GenreFilterBar';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import { filterAlbumsByMixRatings, getMixMinRatingsConfigFromAuth } from '../utils/mix/mixRatingFilter';
import { runLocalRandomAlbums, runLocalAlbumsByGenres } from '../utils/library/browseTextSearch';
import { useOfflineStore } from '../store/offlineStore';
import { useDownloadModalStore } from '../store/downloadModalStore';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { showToast } from '../utils/ui/toast';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import { useRangeSelection } from '../hooks/useRangeSelection';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { albumGridWarmCovers, COVER_DENSE_GRID_MIN_CELL_CSS_PX } from '../cover/layoutSizes';
import {
  primeAlbumCoversForDisplay,
} from '../cover/warmDiskPeek';
import { VirtualCardGrid } from '../components/VirtualCardGrid';

const ALBUM_COUNT = 30;
/** Extra pool when mix rating filter is on so we can still fill the grid after filtering. */
const ALBUM_FETCH_OVERSHOOT = 100;
/** Cap genre-union size before rating prefetch (avoids hundreds of `getArtist` calls). */
const GENRE_UNION_PREFILTER_CAP = 250;

function sanitizeFilename(name: string): string {
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
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const loadingRef = useRef(false);
  const filtered = selectedGenres.length > 0;

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
        await invoke('download_zip', { id: downloadId, url, destPath });
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
        const detail = await getAlbum(album.id);
        downloadAlbum(album.id, album.name, album.artist, album.coverArt, album.year, detail.songs, serverId);
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

  // Keep a ref so the effect closure is always fresh without re-triggering the
  // effect on every `load` reference change. The effect must NOT list `load` as a
  // dep — Zustand rehydration changes deps (e.g. mixMinRatingFilterEnabled) and
  // recreates `load`, which would otherwise double-fire on every page visit and
  // show a different random batch ~1.5 s after the first one.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => { loadRef.current(selectedGenres); }, [selectedGenres]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="content-body animate-fade-in">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>
          {selectionMode && selectedIds.size > 0
            ? t('albums.selectionCount', { count: selectedIds.size })
            : t('randomAlbums.title')}
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          {selectionMode && selectedIds.size > 0 ? (
            <>
              <button className="btn btn-surface albums-selection-action-btn" onClick={handleAddOffline}>
                <HardDriveDownload size={15} />
                {t('albums.addOffline')}
              </button>
              <button className="btn btn-surface albums-selection-action-btn" onClick={handleDownloadZips}>
                <Download size={15} />
                {t('albums.downloadZips')}
              </button>
            </>
          ) : (
            <>
              <GenreFilterBar selected={selectedGenres} onSelectionChange={setSelectedGenres} />
              <button
                className="btn btn-surface"
                onClick={() => load(selectedGenres)}
                disabled={loading}
                data-tooltip={t('randomAlbums.refresh')}
              >
                <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
                {t('randomAlbums.refresh')}
              </button>
            </>
          )}
          <button
            className={`btn btn-surface${selectionMode ? ' btn-sort-active' : ''}`}
            onClick={toggleSelectionMode}
            data-tooltip={selectionMode ? t('albums.cancelSelect') : t('albums.startSelect')}
            data-tooltip-pos="bottom"
            style={selectionMode ? { background: 'var(--accent)', color: 'var(--ctp-crust)' } : {}}
          >
            <CheckSquare2 size={15} />
            {selectionMode ? t('albums.cancelSelect') : t('albums.select')}
          </button>
        </div>
      </div>

      {loading && albums.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <div className="spinner" />
        </div>
      ) : !loading && albums.length === 0 ? (
        <div className="empty-state" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
          {t('common.libraryEmpty')}
        </div>
      ) : (
        <VirtualCardGrid
          items={albums}
          itemKey={(a, _i) => a.id}
          rowVariant="album"
          disableVirtualization={perfFlags.disableMainstageVirtualLists}
          layoutSignal={albums.length}
          warmGridCovers={albumGridWarmCovers()}
          renderItem={a => (
            <AlbumCard
              album={a}
              selectionMode={selectionMode}
              selected={selectedIds.has(a.id)}
              onToggleSelect={toggleSelect}
              selectedAlbums={selectedAlbums}
              ensurePriority="high"
            />
          )}
        />
      )}
    </div>
  );
}
