import { buildDownloadUrl } from '../api/subsonicStreamUrl';
import { setRating, star, unstar } from '../api/subsonicStarRating';
import { queueSongStar, queueSongRating } from '../store/pendingStarSync';
import { getAlbumForServer } from '../api/subsonicLibrary';
import { getArtistInfo } from '../api/subsonicArtists';
import type { SubsonicSong } from '../api/subsonicTypes';
import { songToTrack } from '../utils/playback/songToTrack';
import { shuffleArray } from '../utils/playback/shuffleArray';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useOrbitSongRowBehavior } from '../hooks/useOrbitSongRowBehavior';
import { useAlbumDetailData } from '../hooks/useAlbumDetailData';
import { useAlbumOfflineState } from '../hooks/useAlbumOfflineState';
import { useAlbumDetailSort } from '../hooks/useAlbumDetailSort';
import { useDownloadModalStore } from '../store/downloadModalStore';
import { useOfflineStore } from '../store/offlineStore';
import { useOfflineJobStore } from '../store/offlineJobStore';
import { isOfflinePinComplete } from '../utils/offline/offlineLibraryHelpers';
import { dequeueOfflinePin } from '../utils/offline/offlinePinQueue';
import { reconcileLibraryTierForAlbum } from '../utils/offline/libraryTierReconcile';
import { shouldAttemptSubsonicForServer } from '../utils/network/subsonicNetworkGuard';
import { join } from '@tauri-apps/api/path';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import AlbumCard from '../components/AlbumCard';
import AlbumHeader from '../components/AlbumHeader';
import AlbumTrackList from '../components/AlbumTrackList';
import { AlbumDetailToolbar } from '../components/albumDetail/AlbumDetailToolbar';
import { useCoverArt } from '../cover/useCoverArt';
import {
  forgetAlbumDistinctDiscCovers,
  rememberAlbumDistinctDiscCovers,
} from '../cover/ref';
import { useAlbumCoverRef } from '../cover/useLibraryCoverRef';
import { useTranslation } from 'react-i18next';
import { showToast } from '../utils/ui/toast';
import { useSelectionStore } from '../store/selectionStore';
import { sanitizeFilename } from '../utils/componentHelpers/albumDetailHelpers';
import { albumArtistDisplayName, deriveAlbumHeaderArtistRefs } from '../utils/album/deriveAlbumHeaderArtistRefs';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { albumGridWarmCovers } from '../cover/layoutSizes';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import LosslessModeBanner from '../components/LosslessModeBanner';
import { isLosslessSuffix } from '../utils/library/losslessFormats';
import { isLosslessMode } from '../utils/library/losslessMode';
import { readDetailServerId } from '../utils/navigation/detailServerScope';
import { useOfflineBrowseContext } from '../hooks/useOfflineBrowseContext';
import { offlineActionPolicy } from '../utils/offline/offlineActionPolicy';

export default function AlbumDetail() {
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const losslessOnly = isLosslessMode(searchParams);
  const auth = useAuthStore();
  const requestDownloadFolder = useDownloadModalStore(s => s.requestFolder);
  const playTrack = usePlayerStore(s => s.playTrack);
  const enqueue = usePlayerStore(s => s.enqueue);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const starredOverrides = usePlayerStore(s => s.starredOverrides);
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
  const downloadAlbum = useOfflineStore(s => s.downloadAlbum);
  const deleteAlbum = useOfflineStore(s => s.deleteAlbum);
  const serverId = readDetailServerId(searchParams, auth.activeServerId) ?? '';
  const entityRatingSupportByServer = useAuthStore(s => s.entityRatingSupportByServer);
  const setEntityRatingSupport = useAuthStore(s => s.setEntityRatingSupport);
  const albumEntityRatingSupport = entityRatingSupportByServer[serverId] ?? 'unknown';
  const offlineCtx = useOfflineBrowseContext();
  const albumActionPolicy = offlineActionPolicy('albumDetail', offlineCtx.active);

  const [albumEntityRating, setAlbumEntityRating] = useState(0);
  const [filterText, setFilterText] = useState('');
  const [showPlPicker, setShowPlPicker] = useState(false);
  const selectedCount = useSelectionStore(s => s.selectedIds.size);
  const inSelectMode = selectedCount > 0;

  // Derive a stable albumId for the selectors below (empty string when not yet loaded).
  const albumId = album?.album.id ?? '';

  useEffect(() => {
    if (!id) return;
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (album && album.album.id === id) setAlbumEntityRating(album.album.userRating ?? 0);
    // Keyed on the album's id / userRating primitives; depending on the `album`
    // object would re-run on every render when its identity changes but those do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, album?.album.id, album?.album.userRating]);

  // React Compiler rule: manual memoization is intentional and must be preserved.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const effectiveSongs = useMemo(() => {
    if (!album?.songs) return undefined;
    if (!losslessOnly) return album.songs;
    return album.songs.filter(s => isLosslessSuffix(s.suffix));
  }, [album?.songs, losslessOnly]);

  const offlineSongIds = useMemo(
    () => (effectiveSongs ?? album?.songs ?? []).map(s => s.id),
    [effectiveSongs, album?.songs],
  );
  const { resolvedOfflineStatus, offlineProgress } = useAlbumOfflineState(albumId, serverId, offlineSongIds);

  useEffect(() => {
    if (!albumId || !album || offlineSongIds.length === 0) return;
    const songs = effectiveSongs ?? album.songs;
    let cancelled = false;
    void reconcileLibraryTierForAlbum(
      serverId,
      songs,
      { kind: 'album', sourceId: albumId, displayName: album.album.name },
    ).then(() => {
      if (cancelled) return;
      if (!isOfflinePinComplete(albumId, serverId, offlineSongIds)) return;
      useOfflineJobStore.setState(s => ({
        jobs: s.jobs.filter(j => j.albumId !== albumId),
      }));
    });
    return () => { cancelled = true; };
  }, [albumId, serverId, album, effectiveSongs, offlineSongIds]);

  useEffect(() => {
    if (!albumId || !effectiveSongs?.length) return;
    rememberAlbumDistinctDiscCovers(albumId, effectiveSongs);
    return () => forgetAlbumDistinctDiscCovers(albumId);
  }, [albumId, effectiveSongs]);

const handlePlayAll = () => {
     if (!album || !effectiveSongs) return;
     const albumGenre = album.album.genre;
     const tracks = effectiveSongs.map(s => {
       const t = songToTrack(s);
       if (!t.genre && albumGenre) t.genre = albumGenre;
       return t;
     });
     if (tracks[0]) playTrack(tracks[0], tracks);
   };

const handleEnqueueAll = () => {
     if (!album || !effectiveSongs) return;
     const albumGenre = album.album.genre;
     const tracks = effectiveSongs.map(s => {
       const t = songToTrack(s);
       if (!t.genre && albumGenre) t.genre = albumGenre;
       return t;
     });
     enqueue(tracks);
   };

const handleShuffleAll = () => {
     if (!album || !effectiveSongs) return;
     const albumGenre = album.album.genre;
     const tracks = effectiveSongs.map(s => {
       const t = songToTrack(s);
       if (!t.genre && albumGenre) t.genre = albumGenre;
       return t;
     });
     const shuffled = shuffleArray(tracks);
     if (shuffled[0]) playTrack(shuffled[0], shuffled);
   };

   const { orbitActive, queueHint, addTrackToOrbit } = useOrbitSongRowBehavior();

   const handlePlaySong = (song: SubsonicSong) => {
     if (orbitActive) { queueHint(); return; }
     if (!album || !effectiveSongs) return;
     const albumGenre = album.album.genre;
     const tracks = effectiveSongs.map(s => {
       const t = songToTrack(s);
       if (!t.genre && albumGenre) t.genre = albumGenre;
       return t;
     });
     const track = tracks.find(t => t.id === song.id) || songToTrack(song);
     playTrack(track, tracks);
   };

   const handleDoubleClickSong = (song: SubsonicSong) => addTrackToOrbit(song.id);

  const handleRate = (songId: string, rating: number) => {
    setRatings(r => ({ ...r, [songId]: rating }));
    // F4: optimistic override + retried server sync via the central helper.
    queueSongRating(songId, rating);
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
      const meta = {
        serverId: serverId || album.album.serverId,
        name: album.album.name,
        artist: album.album.artist,
        artistId: album.album.artistId,
        coverArtId: album.album.coverArt,
        year: album.album.year,
      };
      if (wasStarred) await unstar(album.album.id, 'album', meta);
      else await star(album.album.id, 'album', meta);
    } catch (e) {
      console.error('Failed to toggle star', e);
      setIsStarred(wasStarred);
    }
  };

  const toggleSongStar = (song: SubsonicSong, e: React.MouseEvent) => {
    e.stopPropagation();
    const wasStarred = starredSongs.has(song.id);
    const next = new Set(starredSongs);
    if (wasStarred) next.delete(song.id); else next.add(song.id);
    setStarredSongs(next);
    // F4: optimistic override + retried server sync via the central helper.
    queueSongStar(song.id, !wasStarred, song.serverId ?? (serverId || undefined));
  };

  const handleCacheOffline = useCallback(async () => {
    if (!album) return;
    if (resolvedOfflineStatus === 'queued') {
      dequeueOfflinePin(album.album.id);
      return;
    }
    let songs = effectiveSongs ?? album.songs;
    if (serverId && shouldAttemptSubsonicForServer(serverId)) {
      try {
        const fresh = await getAlbumForServer(serverId, album.album.id);
        songs = losslessOnly
          ? fresh.songs.filter(s => isLosslessSuffix(s.suffix))
          : fresh.songs;
      } catch {
        /* keep album.songs from the page */
      }
    }
    if (isOfflinePinComplete(album.album.id, serverId, songs.map(s => s.id))) return;
    downloadAlbum(album.album.id, album.album.name, albumArtistDisplayName(album.album), album.album.coverArt, album.album.year, songs, serverId);
  }, [album, downloadAlbum, serverId, effectiveSongs, losslessOnly, resolvedOfflineStatus]);

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
    songs: effectiveSongs,
    filterText,
    starredSongs: mergedStarredSongs,
    ratings,
    userRatingOverrides,
  });

  const albumCoverRefResolved = useAlbumCoverRef(
    album?.album.id,
    album?.album.coverArt,
    undefined,
    { libraryResolve: true },
  );
  const albumCover = useCoverArt(albumCoverRefResolved, 400, { surface: 'sparse' });
  const resolvedCoverUrl = albumCover.src || null;

  useEffect(() => {
    if (!showPlPicker) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.bulk-pl-picker-wrap')) setShowPlPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPlPicker]);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from an external subscription/event callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!inSelectMode) setShowPlPicker(false);
  }, [inSelectMode]);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;
  if (!album) return <div className="empty-state">{t('albumDetail.notFound')}</div>;

  const { album: info } = album;
  const songs = effectiveSongs ?? [];
  const headerArtistRefs = deriveAlbumHeaderArtistRefs(info, songs);
  const hasVariousArtists = songs.some(s => s.artist !== info.artist);

  return (
    <div className="album-detail animate-fade-in">
      <AlbumHeader
        info={info}
        headerArtistRefs={headerArtistRefs}
        songs={songs}
        coverArtId={info.coverArt}
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
        actionPolicy={albumActionPolicy}
      />
      {losslessOnly && <LosslessModeBanner />}

      {songs.length > 0 && (
        <AlbumDetailToolbar
          filterText={filterText}
          setFilterText={setFilterText}
          inSelectMode={inSelectMode}
          selectedCount={selectedCount}
          showPlPicker={showPlPicker}
          setShowPlPicker={setShowPlPicker}
          t={t}
          actionPolicy={albumActionPolicy}
        />
      )}

      <AlbumTrackList
        songs={displayedSongs}
        discTitles={album?.album.discTitles}
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
        actionPolicy={albumActionPolicy}
      />

      {relatedAlbums.length > 0 && (
        <div className="album-related">
          <div className="album-related-divider" />
          <h2 className="section-title album-related-title">{t('albumDetail.moreByArtist', { artist: info.artist })}</h2>
          <VirtualCardGrid
            items={relatedAlbums}
            itemKey={(a, i) => `${a.id}-${i}`}
            rowVariant="album"
            disableVirtualization={perfFlags.disableMainstageVirtualLists}
            layoutSignal={relatedAlbums.length}
            warmGridCovers={albumGridWarmCovers()}
            renderItem={a => <AlbumCard album={a} />}
          />
        </div>
      )}
    </div>
  );
}
