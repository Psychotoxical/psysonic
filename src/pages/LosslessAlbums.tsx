import { buildDownloadUrl } from '../api/subsonicStreamUrl';
import { getAlbum } from '../api/subsonicLibrary';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { songToTrack } from '../utils/songToTrack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import AlbumCard from '../components/AlbumCard';
import { ndListLosslessAlbumsPage } from '../api/navidromeBrowse';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import { useOfflineStore } from '../store/offlineStore';
import { useDownloadModalStore } from '../store/downloadModalStore';
import { usePlayerStore } from '../store/playerStore';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import { useRangeSelection } from '../hooks/useRangeSelection';
import { usePerfProbeFlags } from '../utils/perfFlags';
import { showToast } from '../utils/toast';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { CheckSquare2, Download, HardDriveDownload, ListPlus } from 'lucide-react';

/** Per-loadMore budget — tuned for snappy initial paint over completeness.
 *  100 songs ≈ 500 KB response (Navidrome's /api/song carries lyrics/tags/
 *  participants and ignores `_fields`); 2 internal pages = ~1 MB worst case
 *  per loadMore, much faster than the rail's 5×200 = 1000-song budget. The
 *  page makes up for the smaller batch by triggering a fresh loadMore on
 *  scroll, so the user sees albums sooner instead of waiting on a fat call. */
const PAGE_TARGET_ALBUMS = 12;
const PAGE_SONGS_PER_FETCH = 100;
const PAGE_MAX_FETCHES_PER_LOAD = 2;

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'download';
}

export default function LosslessAlbums() {
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const auth = useAuthStore();
  const activeServerId = useAuthStore(s => s.activeServerId);
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const downloadAlbum = useOfflineStore(s => s.downloadAlbum);
  const requestDownloadFolder = useDownloadModalStore(s => s.requestFolder);
  const enqueue = usePlayerStore(s => s.enqueue);

  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [unsupported, setUnsupported] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);

  const { selectedIds, toggleSelect, clearSelection: resetSelection } = useRangeSelection(albums);
  const selectedAlbums = albums.filter(a => selectedIds.has(a.id));

  const toggleSelectionMode = () => { setSelectionMode(v => !v); resetSelection(); };
  const clearSelection = () => { setSelectionMode(false); resetSelection(); };

  /** Pagination cursor + dedupe set, kept across loadMore calls so each page
   *  resumes the song-stream walk where the previous one left off. Reset to
   *  a fresh pair whenever the active server changes. */
  const songCursor = useRef(0);
  const seenIds = useRef<Set<string>>(new Set());
  /** Re-entrancy guard. The IntersectionObserver can fire repeatedly while a
   *  previous loadMore is still in flight (fast scroll, sentinel re-entering
   *  the rootMargin band) — without this guard, two concurrent calls would
   *  read the same songCursor, fetch the same song page, and push duplicate
   *  album entries because each captures its own snapshot of the seen-Set
   *  reference. */
  const inFlight = useRef(false);
  const observerTarget = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const page = await ndListLosslessAlbumsPage({
        startSongOffset: songCursor.current,
        seenAlbumIds: seenIds.current,
        targetNewAlbums: PAGE_TARGET_ALBUMS,
        songsPerPage: PAGE_SONGS_PER_FETCH,
        maxPagesPerCall: PAGE_MAX_FETCHES_PER_LOAD,
        onProgress: (newEntries) => {
          setAlbums(prev => [...prev, ...newEntries.map(e => e.album)]);
        },
      });
      songCursor.current = page.nextSongOffset;
      setHasMore(!page.done);
    } catch {
      setUnsupported(true);
      setHasMore(false);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    songCursor.current = 0;
    seenIds.current = new Set();
    inFlight.current = false;
    setAlbums([]);
    setHasMore(true);
    setUnsupported(false);
    setLoading(true);

    (async () => {
      inFlight.current = true;
      try {
        const page = await ndListLosslessAlbumsPage({
          startSongOffset: 0,
          seenAlbumIds: seenIds.current,
          targetNewAlbums: PAGE_TARGET_ALBUMS,
          songsPerPage: PAGE_SONGS_PER_FETCH,
          maxPagesPerCall: PAGE_MAX_FETCHES_PER_LOAD,
          onProgress: (newEntries) => {
            if (cancelled) return;
            setAlbums(prev => [...prev, ...newEntries.map(e => e.album)]);
          },
        });
        if (cancelled) return;
        songCursor.current = page.nextSongOffset;
        setHasMore(!page.done);
      } catch {
        if (cancelled) return;
        setUnsupported(true);
        setHasMore(false);
      } finally {
        inFlight.current = false;
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [activeServerId]);

  useEffect(() => {
    if (!hasMore) return;
    const node = observerTarget.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: '200px' },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [hasMore, loadMore, loading, albums.length]);

  const handleEnqueueSelected = async () => {
    if (selectedAlbums.length === 0) return;
    try {
      const results = await Promise.all(selectedAlbums.map(a => getAlbum(a.id).catch(() => null)));
      const tracks = results.flatMap(r => r ? r.songs.map(songToTrack) : []);
      if (tracks.length > 0) {
        enqueue(tracks);
        showToast(t('albums.enqueueQueued', { count: selectedAlbums.length }), 2500, 'info');
      }
    } finally {
      clearSelection();
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

  return (
    <div className="content-body animate-fade-in">
      {!perfFlags.disableMainstageStickyHeader && (
        <div className="page-sticky-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', minWidth: 0 }}>
            <h1 className="page-title" style={{ marginBottom: 0 }}>
              {selectionMode && selectedIds.size > 0
                ? t('albums.selectionCount', { count: selectedIds.size })
                : t('home.losslessAlbums')}
            </h1>
            {!(selectionMode && selectedIds.size > 0) && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, lineHeight: 1.3 }}>
                {t('losslessAlbums.slowFetchHint')}
              </p>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            {selectionMode && selectedIds.size > 0 && (
              <>
                <button className="btn btn-surface albums-selection-action-btn" onClick={handleEnqueueSelected}>
                  <ListPlus size={15} />
                  {t('albums.enqueueSelected', { count: selectedIds.size })}
                </button>
                <button className="btn btn-surface albums-selection-action-btn" onClick={handleAddOffline}>
                  <HardDriveDownload size={15} />
                  {t('albums.addOffline')}
                </button>
                <button className="btn btn-surface albums-selection-action-btn" onClick={handleDownloadZips}>
                  <Download size={15} />
                  {t('albums.downloadZips')}
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
      )}

      {unsupported ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          {t('losslessAlbums.unsupported')}
        </div>
      ) : loading && albums.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
          <div className="spinner" />
        </div>
      ) : albums.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          {t('losslessAlbums.empty')}
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
          <div ref={observerTarget} style={{ height: '20px', margin: '2rem 0', display: 'flex', justifyContent: 'center' }}>
            {loading && hasMore && <div className="spinner" style={{ width: 20, height: 20 }} />}
          </div>
        </>
      )}
    </div>
  );
}
