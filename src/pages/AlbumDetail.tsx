import { buildCoverArtUrl, coverArtCacheKey, buildDownloadUrl } from '../api/subsonicStreamUrl';
import { setRating, star, unstar } from '../api/subsonicStarRating';
import { getArtist, getArtistInfo } from '../api/subsonicArtists';
import { getAlbum } from '../api/subsonicLibrary';
import type { SubsonicSong, SubsonicAlbum } from '../api/subsonicTypes';
import { songToTrack } from '../utils/songToTrack';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Search, X, ListPlus } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useOrbitSongRowBehavior } from '../hooks/useOrbitSongRowBehavior';
import { useDownloadModalStore } from '../store/downloadModalStore';
import { useOfflineStore } from '../store/offlineStore';
import { useOfflineJobStore } from '../store/offlineJobStore';
import { join } from '@tauri-apps/api/path';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import AlbumCard from '../components/AlbumCard';
import AlbumHeader from '../components/AlbumHeader';
import AlbumTrackList from '../components/AlbumTrackList';
import { AddToPlaylistSubmenu } from '../components/ContextMenu';
import { useCachedUrl } from '../components/CachedImage';
import { useTranslation } from 'react-i18next';
import { showToast } from '../utils/toast';
import { useSelectionStore } from '../store/selectionStore';

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .substring(0, 200) || 'download';
}

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

  const [album, setAlbum] = useState<Awaited<ReturnType<typeof getAlbum>> | null>(null);
  const [relatedAlbums, setRelatedAlbums] = useState<SubsonicAlbum[]>([]);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [bio, setBio] = useState<string | null>(null);
  const [bioOpen, setBioOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isStarred, setIsStarred] = useState(false);
  const [starredSongs, setStarredSongs] = useState<Set<string>>(new Set());
  const [offlineStorageFull, setOfflineStorageFull] = useState(false);

  const downloadAlbum = useOfflineStore(s => s.downloadAlbum);
  const deleteAlbum = useOfflineStore(s => s.deleteAlbum);
  const serverId = auth.activeServerId ?? '';
  const entityRatingSupportByServer = useAuthStore(s => s.entityRatingSupportByServer);
  const setEntityRatingSupport = useAuthStore(s => s.setEntityRatingSupport);
  const albumEntityRatingSupport = entityRatingSupportByServer[serverId] ?? 'unknown';

  const [albumEntityRating, setAlbumEntityRating] = useState(0);
  const [filterText, setFilterText] = useState('');
  const [sortKey, setSortKey] = useState<'natural' | 'title' | 'artist' | 'album' | 'favorite' | 'rating' | 'duration'>('natural');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [sortClickCount, setSortClickCount] = useState(0);
  const [showPlPicker, setShowPlPicker] = useState(false);
  const selectedCount = useSelectionStore(s => s.selectedIds.size);
  const inSelectMode = selectedCount > 0;

  // Derive a stable albumId for the selectors below (empty string when not yet loaded).
  const albumId = album?.album.id ?? '';

  // Selectors return primitives so Zustand only triggers a re-render when the VALUE
  // actually changes — not on every `jobs` array mutation during batch downloads.
  const offlineStatus = useOfflineStore((s): 'none' | 'downloading' | 'cached' => {
    if (!albumId) return 'none';
    const meta = s.albums[`${serverId}:${albumId}`];
    const isDownloaded = meta && meta.trackIds.length > 0 && meta.trackIds.every(tid => !!s.tracks[`${serverId}:${tid}`]);
    return isDownloaded ? 'cached' : 'none';
  });
  const isOfflineDownloading = useOfflineJobStore(s =>
    !!albumId && s.jobs.some(j => j.albumId === albumId && (j.status === 'queued' || j.status === 'downloading'))
  );
  const offlineProgressDone = useOfflineJobStore(s => {
    if (!albumId) return 0;
    return s.jobs.filter(j => j.albumId === albumId && (j.status === 'done' || j.status === 'error')).length;
  });
  const offlineProgressTotal = useOfflineJobStore(s => {
    if (!albumId) return 0;
    return s.jobs.filter(j => j.albumId === albumId).length;
  });
  const resolvedOfflineStatus = isOfflineDownloading ? 'downloading' : offlineStatus;
  const offlineProgress = offlineProgressTotal > 0
    ? { done: offlineProgressDone, total: offlineProgressTotal }
    : null;

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setRelatedAlbums([]);
    getAlbum(id).then(async data => {
      setAlbum(data);
      setIsStarred(!!data.album.starred);
      const initialStarred = new Set<string>();
      data.songs.forEach(s => { if (s.starred) initialStarred.add(s.id); });
      setStarredSongs(initialStarred);
      setLoading(false);
      try {
        const artistData = await getArtist(data.album.artistId);
        setRelatedAlbums(artistData.albums.filter(a => a.id !== id));
      } catch (e) {
        console.error('Failed to fetch related albums', e);
      }
    }).catch(() => setLoading(false));
  }, [id]);

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

  const handleSort = (key: typeof sortKey) => {
    if (key === 'natural') return;
    if (sortKey === key) {
      const nextCount = sortClickCount + 1;
      if (nextCount >= 3) {
        setSortKey('natural');
        setSortDir('asc');
        setSortClickCount(0);
      } else {
        setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        setSortClickCount(nextCount);
      }
    } else {
      setSortKey(key);
      setSortDir('asc');
      setSortClickCount(1);
    }
  };

  // Must be before early returns — hooks must be called unconditionally.
  const mergedStarredSongs = useMemo(() => new Set([
    ...[...starredSongs].filter(id => starredOverrides[id] !== false),
    ...Object.entries(starredOverrides).filter(([, v]) => v).map(([k]) => k),
  ]), [starredSongs, starredOverrides]);

  const displayedSongs = useMemo(() => {
    if (!album) return [];
    const q = filterText.trim().toLowerCase();
    if (!q && sortKey === 'natural') return album.songs;
    let result = [...album.songs];
    if (q) result = result.filter(s => s.title.toLowerCase().includes(q) || (s.artist ?? '').toLowerCase().includes(q));
    if (sortKey !== 'natural') {
      result.sort((a, b) => {
        let av: string | number;
        let bv: string | number;
        switch (sortKey) {
          case 'title': av = a.title; bv = b.title; break;
          case 'artist': av = a.artist ?? ''; bv = b.artist ?? ''; break;
          case 'album': av = a.album ?? ''; bv = b.album ?? ''; break;
          case 'favorite':
            av = mergedStarredSongs.has(a.id) ? 1 : 0;
            bv = mergedStarredSongs.has(b.id) ? 1 : 0;
            break;
          case 'rating':
            av = ratings[a.id] ?? userRatingOverrides[a.id] ?? a.userRating ?? 0;
            bv = ratings[b.id] ?? userRatingOverrides[b.id] ?? b.userRating ?? 0;
            break;
          case 'duration': av = a.duration ?? 0; bv = b.duration ?? 0; break;
          default: av = a.title; bv = b.title;
        }
        if (typeof av === 'number' && typeof bv === 'number') {
          return sortDir === 'asc' ? av - bv : bv - av;
        }
        return sortDir === 'asc' ? (av as string).localeCompare(bv as string) : (bv as string).localeCompare(av as string);
      });
    }
    return result;
  }, [album, filterText, sortKey, sortDir, mergedStarredSongs, ratings, userRatingOverrides]);

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
        <div className="album-track-toolbar">
          <div className="album-track-toolbar-filter">
            <Search size={16} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
            <input
              className="input-search"
              style={{ width: '100%', paddingRight: filterText ? 28 : undefined }}
              placeholder={t('albumDetail.filterSongs')}
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
            />
            {filterText && (
              <button
                style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onClick={() => setFilterText('')}
                aria-label="Clear filter"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div className="album-track-toolbar-actions">
            {inSelectMode && (
              <>
                <span className="bulk-action-count">
                  {t('common.bulkSelected', { count: selectedCount })}
                </span>
                <div className="bulk-pl-picker-wrap">
                  <button
                    className="btn btn-surface btn-sm"
                    onClick={() => setShowPlPicker(v => !v)}
                  >
                    <ListPlus size={14} />
                    {t('common.bulkAddToPlaylist')}
                  </button>
                  {showPlPicker && (
                    <AddToPlaylistSubmenu
                      songIds={[...useSelectionStore.getState().selectedIds]}
                      onDone={() => { setShowPlPicker(false); useSelectionStore.getState().clearAll(); }}
                      dropDown
                    />
                  )}
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => useSelectionStore.getState().clearAll()}
                >
                  <X size={13} />
                  {t('common.bulkClear')}
                </button>
              </>
            )}
          </div>
        </div>
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
