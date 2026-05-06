import React, { useEffect, useState, useCallback, useRef } from 'react';
import { RefreshCw, CheckSquare2, Download, HardDriveDownload } from 'lucide-react';
import { getAlbumList, getAlbumsByGenre, getAlbum, SubsonicAlbum, buildDownloadUrl } from '../api/subsonic';
import AlbumCard from '../components/AlbumCard';
import GenreFilterBar from '../components/GenreFilterBar';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import { filterAlbumsByMixRatings, getMixMinRatingsConfigFromAuth } from '../utils/mixRatingFilter';
import { useOfflineStore } from '../store/offlineStore';
import { useDownloadModalStore } from '../store/downloadModalStore';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { showToast } from '../utils/toast';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import { useRangeSelection } from '../hooks/useRangeSelection';

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
  const seen = new Set<string>();
  const union = results.flat().filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; });
  for (let i = union.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [union[i], union[j]] = [union[j], union[i]];
  }
  const pool = union.slice(0, GENRE_UNION_PREFILTER_CAP);
  const filtered = await filterAlbumsByMixRatings(pool, getMixMinRatingsConfigFromAuth());
  return filtered.slice(0, ALBUM_COUNT);
}

export default function RandomAlbums() {
  const { t } = useTranslation();
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
      const mixCfg = getMixMinRatingsConfigFromAuth();
      const albumMixActive =
        mixCfg.enabled && (mixCfg.minAlbum > 0 || mixCfg.minArtist > 0);
      const randomSize = albumMixActive ? Math.max(ALBUM_COUNT * 3, ALBUM_FETCH_OVERSHOOT) : ALBUM_COUNT;
      const data = genres.length > 0
        ? await fetchByGenres(genres)
        : (await filterAlbumsByMixRatings(await getAlbumList('random', randomSize), mixCfg)).slice(0, ALBUM_COUNT);
      setAlbums(data);
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

  useEffect(() => { load(selectedGenres); }, [selectedGenres, load]);

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
      ) : (
        <div className="album-grid-wrap">
          {albums.map(a => (
            <AlbumCard
              key={a.id}
              album={a}
              selectionMode={selectionMode}
              selected={selectedIds.has(a.id)}
              onToggleSelect={toggleSelect}
              selectedAlbums={selectedAlbums}
            />
          ))}
        </div>
      )}
    </div>
  );
}
