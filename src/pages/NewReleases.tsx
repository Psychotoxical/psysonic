import type { SubsonicAlbum } from '../api/subsonicTypes';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { CheckSquare2, Download, HardDriveDownload, ListMusic } from 'lucide-react';
import AlbumCard from '../components/AlbumCard';
import GenreFilterBar from '../components/GenreFilterBar';
import { getAlbumList, getAlbumsByGenre, getAlbum, buildDownloadUrl } from '../api/subsonic';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import { useOfflineStore } from '../store/offlineStore';
import { useDownloadModalStore } from '../store/downloadModalStore';
import { usePlayerStore } from '../store/playerStore';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { showToast } from '../utils/toast';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import { useRangeSelection } from '../hooks/useRangeSelection';

const PAGE_SIZE = 30;

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'download';
}

async function fetchByGenres(genres: string[]): Promise<SubsonicAlbum[]> {
  const results = await Promise.all(genres.map(g => getAlbumsByGenre(g, 500, 0)));
  const seen = new Set<string>();
  const union = results.flat().filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; });
  return union.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
}

export default function NewReleases() {
  const { t } = useTranslation();
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const auth = useAuthStore();
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const downloadAlbum = useOfflineStore(s => s.downloadAlbum);
  const requestDownloadFolder = useDownloadModalStore(s => s.requestFolder);

  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const observerTarget = useRef<HTMLDivElement>(null);
  const filtered = selectedGenres.length > 0;

  const [selectionMode, setSelectionMode] = useState(false);
  const { selectedIds, toggleSelect, clearSelection: resetSelection } = useRangeSelection(albums);

  const toggleSelectionMode = () => { setSelectionMode(v => !v); resetSelection(); };
  const clearSelection = () => { setSelectionMode(false); resetSelection(); };
  const selectedAlbums = albums.filter(a => selectedIds.has(a.id));
  const openContextMenu = usePlayerStore(state => state.openContextMenu);

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

  const load = useCallback(async (offset: number, append = false) => {
    setLoading(true);
    try {
      const data = await getAlbumList('newest', PAGE_SIZE, offset);
      if (append) setAlbums(prev => [...prev, ...data]);
      else setAlbums(data);
      setHasMore(data.length === PAGE_SIZE);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFiltered = useCallback(async (genres: string[]) => {
    setLoading(true);
    try {
      setAlbums(await fetchByGenres(genres));
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [musicLibraryFilterVersion]);

  useEffect(() => {
    if (filtered) loadFiltered(selectedGenres);
    else { setPage(0); load(0); }
  }, [filtered, selectedGenres, load, loadFiltered]);

  const loadMore = useCallback(() => {
    if (loading || !hasMore || filtered) return;
    const next = page + 1;
    setPage(next);
    load(next * PAGE_SIZE, true);
  }, [loading, hasMore, page, load, filtered]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: '200px' }
    );
    if (observerTarget.current) observer.observe(observerTarget.current);
    return () => observer.disconnect();
  }, [loadMore]);

  return (
    <div className="content-body animate-fade-in">
      <div className="page-sticky-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>
          {selectionMode && selectedIds.size > 0
            ? t('albums.selectionCount', { count: selectedIds.size })
            : t('sidebar.newReleases')}
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
            <GenreFilterBar selected={selectedGenres} onSelectionChange={setSelectedGenres} />
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
        <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
          <div className="spinner" />
        </div>
      ) : (
        <>
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
          {!filtered && (
            <div ref={observerTarget} style={{ height: '20px', margin: '2rem 0', display: 'flex', justifyContent: 'center' }}>
              {loading && hasMore && <div className="spinner" style={{ width: 20, height: 20 }} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
