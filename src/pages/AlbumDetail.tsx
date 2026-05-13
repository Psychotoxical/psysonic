import { buildCoverArtUrl, coverArtCacheKey, buildDownloadUrl } from '../api/subsonicStreamUrl';
import { setRating, star, unstar } from '../api/subsonicStarRating';
import { getArtistInfo } from '../api/subsonicArtists';
import type { SubsonicSong } from '../api/subsonicTypes';
import { songToTrack } from '../utils/songToTrack';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useOrbitSongRowBehavior } from '../hooks/useOrbitSongRowBehavior';
import { useAlbumDetailData } from '../hooks/useAlbumDetailData';
import { useAlbumOfflineState } from '../hooks/useAlbumOfflineState';
import { useAlbumDetailSort } from '../hooks/useAlbumDetailSort';
import { useDownloadModalStore } from '../store/downloadModalStore';
import { useOfflineStore } from '../store/offlineStore';
import { join } from '@tauri-apps/api/path';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import AlbumCard from '../components/AlbumCard';
import AlbumHeader from '../components/AlbumHeader';
import AlbumTrackList from '../components/AlbumTrackList';
import { AlbumDetailToolbar } from '../components/albumDetail/AlbumDetailToolbar';
import { useCachedUrl } from '../components/CachedImage';
import { useTranslation } from 'react-i18next';
import { showToast } from '../utils/toast';
import { useSelectionStore } from '../store/selectionStore';
import { sanitizeFilename } from '../utils/albumDetailHelpers';

export default function AlbumDetail() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const auth = useAuthStore();
  const requestDownloadFolder = useDownloadModalStore(s => s.requestFolder);
  const playTrack = usePlayerStore(s => s.playTrack);
  const enqueue = usePlayerStore(s => s.enqueue);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const setStarredOverride = usePlayerStore(s => s.setStarredOverride);
  const userRatingOverrides = usePlayerStore(s => s.userRatingOverrides);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);

  const {
    album, setAlbum, relatedAlbums, loading,
    isStarred, setIsStarred, starredSongs, setStarredSongs,
  } = useAlbumDetailData(id);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [bio, setBio] = useState<string | null>(null);
  const [bioOpen, setBioOpen] = useState(false);
  const [offlineStorageFull, setOfflineStorageFull] = useState(false);

  const downloadAlbum = useOfflineStore(s => s.downloadAlbum);
  const deleteAlbum = useOfflineStore(s => s.deleteAlbum);
  const serverId = auth.activeServerId ?? '';
  const entityRatingSupportByServer = useAuthStore(s => s.entityRatingSupportByServer);
  const setEntityRatingSupport = useAuthStore(s => s.setEntityRatingSupport);
  const albumEntityRatingSupport = entityRatingSupportByServer[serverId] ?? 'unknown';

  const [albumEntityRating, setAlbumEntityRating] = useState(0);
  const [filterText, setFilterText] = useState('');
  const [showPlPicker, setShowPlPicker] = useState(false);
  const selectedCount = useSelectionStore(s => s.selectedIds.size);
  const inSelectMode = selectedCount > 0;

  // Derive a stable albumId for the selectors below (empty string when not yet loaded).
  const albumId = album?.album.id ?? '';

  const { resolvedOfflineStatus, offlineProgress } = useAlbumOfflineState(albumId, serverId);

  useEffect(() => {
    if (!id) return;
    if (album && album.album.id === id) setAlbumEntityRating(album.album.userRating ?? 0);
  }, [id, album?.album.id, album?.album.userRating]);

const handlePlayAll = () => {
     if (!album) return;
     const albumGenre = album.album.genre;
     const tracks = album.songs.map(s => {
       const t = songToTrack(s);
       if (!t.genre && albumGenre) t.genre = albumGenre;
       return t;
     });
     if (tracks[0]) playTrack(tracks[0], tracks);
   };

const handleEnqueueAll = () => {
     if (!album) return;
     const albumGenre = album.album.genre;
     const tracks = album.songs.map(s => {
       const t = songToTrack(s);
       if (!t.genre && albumGenre) t.genre = albumGenre;
       return t;
     });
     enqueue(tracks);
   };

const handleShuffleAll = () => {
     if (!album) return;
     const albumGenre = album.album.genre;
     const tracks = album.songs.map(s => {
       const t = songToTrack(s);
       if (!t.genre && albumGenre) t.genre = albumGenre;
       return t;
     });
     const shuffled = [...tracks];
     for (let i = shuffled.length - 1; i > 0; i--) {
       const j = Math.floor(Math.random() * (i + 1));
       [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
     }
     if (shuffled[0]) playTrack(shuffled[0], shuffled);
   };

   const { orbitActive, queueHint, addTrackToOrbit } = useOrbitSongRowBehavior();

   const handlePlaySong = (song: SubsonicSong) => {
     if (orbitActive) { queueHint(); return; }
     if (!album) return;
     const albumGenre = album.album.genre;
     const tracks = album.songs.map(s => {
       const t = songToTrack(s);
       if (!t.genre && albumGenre) t.genre = albumGenre;
       return t;
     });
     const track = tracks.find(t => t.id === song.id) || songToTrack(song);
     playTrack(track, tracks);
   };

   const handleDoubleClickSong = (song: SubsonicSong) => addTrackToOrbit(song.id);

  const handleRate = async (songId: string, rating: number) => {
    setRatings(r => ({ ...r, [songId]: rating }));
    usePlayerStore.getState().setUserRatingOverride(songId, rating);
    await setRating(songId, rating);
  };

  const handleAlbumEntityRating = async (rating: number) => {
    if (!album || album.album.id !== id) return;
    const albumId = album.album.id;
    const ratingAtStart = album.album.userRating ?? 0;

    setAlbumEntityRating(rating);

    if (albumEntityRatingSupport !== 'full') return;

    try {
      await setRating(albumId, rating);
      setAlbum(cur =>
        cur && cur.album.id === albumId
          ? { ...cur, album: { ...cur.album, userRating: rating } }
          : cur,
      );
    } catch (err) {
      setAlbumEntityRating(ratingAtStart);
      setEntityRatingSupport(serverId, 'track_only');
      showToast(
        typeof err === 'string' ? err : err instanceof Error ? err.message : t('entityRating.saveFailed'),
        4500,
        'error',
      );
    }
  };

  const handleBio = async () => {
    if (!album) return;
    if (bio) { setBioOpen(true); return; }
    const info = await getArtistInfo(album.album.artistId);
    setBio(info.biography ?? t('albumDetail.noBio'));
    setBioOpen(true);
  };

  const handleDownload = async () => {
    if (!album) return;
    const { name, id: albumId } = album.album;

    const folder = auth.downloadFolder || await requestDownloadFolder();
    if (!folder) return;

    const filename = `${sanitizeFilename(name)}.zip`;
    const destPath = await join(folder, filename);
    const url = buildDownloadUrl(albumId);
    const downloadId = crypto.randomUUID();

    const { start, complete, fail } = useZipDownloadStore.getState();
    start(downloadId, filename);
    try {
      await invoke('download_zip', { id: downloadId, url, destPath });
      complete(downloadId);
    } catch (e) {
      fail(downloadId);
      console.error('ZIP download failed:', e);
    }
  };

  const toggleStar = async () => {
    if (!album) return;
    const wasStarred = isStarred;
    setIsStarred(!wasStarred);
    try {
      if (wasStarred) await unstar(album.album.id);
      else await star(album.album.id);
    } catch (e) {
      console.error('Failed to toggle star', e);
      setIsStarred(wasStarred);
    }
  };

  const toggleSongStar = async (song: SubsonicSong, e: React.MouseEvent) => {
    e.stopPropagation();
    const wasStarred = starredSongs.has(song.id);
    const next = new Set(starredSongs);
    if (wasStarred) next.delete(song.id); else next.add(song.id);
    setStarredSongs(next);
    setStarredOverride(song.id, !wasStarred);
    try {
      if (wasStarred) await unstar(song.id, 'song');
      else await star(song.id, 'song');
    } catch (err) {
      console.error('Failed to toggle song star', err);
      setStarredSongs(new Set(starredSongs));
      setStarredOverride(song.id, wasStarred);
    }
  };

  const handleCacheOffline = useCallback(async () => {
    if (!album) return;
    const maxBytes = auth.maxCacheMb * 1024 * 1024;
    try {
      const usedBytes = await invoke<number>('get_offline_cache_size');
      if (usedBytes >= maxBytes) {
        setOfflineStorageFull(true);
        return;
      }
    } catch {
      // If we can't check, proceed anyway
    }
    setOfflineStorageFull(false);
    downloadAlbum(album.album.id, album.album.name, album.album.artist, album.album.coverArt, album.album.year, album.songs, serverId);
  }, [album, auth.maxCacheMb, downloadAlbum, serverId]);

  const handleRemoveOffline = () => {
    if (!album) return;
    deleteAlbum(album.album.id, serverId);
  };

  // Must be before early returns — hooks must be called unconditionally.
  const mergedStarredSongs = useMemo(() => new Set([
    ...[...starredSongs].filter(id => starredOverrides[id] !== false),
    ...Object.entries(starredOverrides).filter(([, v]) => v).map(([k]) => k),
  ]), [starredSongs, starredOverrides]);

  const { sortKey, sortDir, handleSort, displayedSongs } = useAlbumDetailSort({
    songs: album?.songs,
    filterText,
    starredSongs: mergedStarredSongs,
    ratings,
    userRatingOverrides,
  });

  // Hooks must be called unconditionally — derive from nullable album state.
  // useMemo is required: buildCoverArtUrl generates a new salt on every call, so without
  // memoization every re-render (e.g. currentTrack change) produces a new fetchUrl,
  // which cancels and restarts the useCachedUrl effect → background never resolves.
  const coverUrl = useMemo(() => album?.album.coverArt ? buildCoverArtUrl(album.album.coverArt, 400) : '', [album?.album.coverArt]);
  const coverKey = useMemo(() => album?.album.coverArt ? coverArtCacheKey(album.album.coverArt, 400) : '', [album?.album.coverArt]);
  const resolvedCoverUrl = useCachedUrl(coverUrl, coverKey);

  useEffect(() => {
    if (!showPlPicker) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.bulk-pl-picker-wrap')) setShowPlPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPlPicker]);

  useEffect(() => {
    if (!inSelectMode) setShowPlPicker(false);
  }, [inSelectMode]);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;
  if (!album) return <div className="empty-state">{t('albumDetail.notFound')}</div>;

  const { album: info, songs } = album;
  const hasVariousArtists = songs.some(s => s.artist !== info.artist);

  return (
    <div className="album-detail animate-fade-in">
      <AlbumHeader
        info={info}
        songs={songs}
        coverUrl={coverUrl}
        coverKey={coverKey}
        resolvedCoverUrl={resolvedCoverUrl}
        isStarred={isStarred}
        downloadProgress={null}
        bio={bio}
        bioOpen={bioOpen}
        onToggleStar={toggleStar}
        onDownload={handleDownload}
        onPlayAll={handlePlayAll}
        onEnqueueAll={handleEnqueueAll}
        onShuffleAll={handleShuffleAll}
        onBio={handleBio}
        onCloseBio={() => setBioOpen(false)}
        offlineStatus={resolvedOfflineStatus}
        offlineProgress={offlineProgress}
        onCacheOffline={handleCacheOffline}
        onRemoveOffline={handleRemoveOffline}
        entityRatingValue={albumEntityRating}
        onEntityRatingChange={handleAlbumEntityRating}
        entityRatingSupport={albumEntityRatingSupport}
      />
      {offlineStorageFull && (
        <div className="offline-storage-full-banner" role="alert">
          <span>{t('albumDetail.offlineStorageFull', { mb: auth.maxCacheMb })}</span>
          <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => navigate('/offline')}>
            {t('albumDetail.offlineStorageGoToLibrary')}
          </button>
          <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => navigate('/settings', { state: { tab: 'library' } })}>
            {t('albumDetail.offlineStorageGoToSettings')}
          </button>
          <button className="offline-storage-full-dismiss" onClick={() => setOfflineStorageFull(false)} aria-label="Dismiss">×</button>
        </div>
      )}

      {songs.length > 0 && (
        <AlbumDetailToolbar
          filterText={filterText}
          setFilterText={setFilterText}
          inSelectMode={inSelectMode}
          selectedCount={selectedCount}
          showPlPicker={showPlPicker}
          setShowPlPicker={setShowPlPicker}
          t={t}
        />
      )}

      <AlbumTrackList
        songs={displayedSongs}
        sorted={sortKey !== 'natural' || !!filterText.trim()}
        hasVariousArtists={hasVariousArtists}
        currentTrack={currentTrack}
        isPlaying={isPlaying}
        ratings={ratings}
        userRatingOverrides={userRatingOverrides}
        starredSongs={mergedStarredSongs}
        onPlaySong={handlePlaySong}
        onDoubleClickSong={orbitActive ? handleDoubleClickSong : undefined}
        onRate={handleRate}
        onToggleSongStar={toggleSongStar}
        onContextMenu={openContextMenu}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
      />

      {relatedAlbums.length > 0 && (
        <div className="album-related">
          <div className="album-related-divider" />
          <h2 className="section-title album-related-title">{t('albumDetail.moreByArtist', { artist: info.artist })}</h2>
          <div className="album-grid-wrap">
            {relatedAlbums.map(a => <AlbumCard key={a.id} album={a} />)}
          </div>
        </div>
      )}
    </div>
  );
}
