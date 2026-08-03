import { buildDownloadUrlForServer } from '@/lib/api/subsonicStreamUrl';
import { setRating, star, unstar } from '@/lib/api/subsonicStarRating';
import { queueSongStar, queueSongRating } from '@/features/playback/store/pendingStarSync';
import { getAlbumForServer } from '@/lib/api/subsonicLibrary';
import { getArtistInfoForServer } from '@/lib/api/subsonicArtists';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { songToTrack } from '@/lib/media/songToTrack';
import { shuffleArray } from '@/lib/util/shuffleArray';
import { ownedEntityKey, ownedOverrideValue } from '@/lib/util/ownedEntityKey';
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { downloadZip } from '@/lib/api/downloadZip';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { useOrbitSongRowBehavior } from '@/features/orbit';
import { useAlbumDetailData } from '@/features/album/hooks/useAlbumDetailData';
import { useAlbumServerMetadataReconcile } from '@/features/album/hooks/useAlbumServerMetadataReconcile';
import { useAlbumOfflineState } from '@/features/album/hooks/useAlbumOfflineState';
import { useAlbumDetailSort } from '@/features/album/hooks/useAlbumDetailSort';
import { useDownloadModalStore } from '@/features/offline';
import { useOfflineStore } from '@/features/offline';
import { useOfflineJobStore } from '@/features/offline';
import { isOfflinePinComplete } from '@/features/offline';
import { dequeueOfflinePin } from '@/features/offline';
import { reconcileLibraryTierForAlbum } from '@/features/offline';
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';
import { join } from '@tauri-apps/api/path';
import { useZipDownloadStore } from '@/features/offline';
import AlbumCard from '@/features/album/components/AlbumCard';
import AlbumHeader from '@/features/album/components/AlbumHeader';
import AlbumTrackList from '@/features/album/components/AlbumTrackList';
import { AlbumDetailToolbar } from '@/features/album/components/AlbumDetailToolbar';
import { useCoverArt } from '@/cover/useCoverArt';
import {
  forgetAlbumDistinctDiscCovers,
  rememberAlbumDistinctDiscCovers,
} from '@/cover/ref';
import { useAlbumCoverRef } from '@/cover/useLibraryCoverRef';
import { coverServerScopeForServerId } from '@/cover/serverScope';
import { useTranslation } from 'react-i18next';
import { showToast } from '@/lib/dom/toast';
import { useSelectionStore } from '@/store/selectionStore';
import { sanitizeFilename } from '@/features/album/utils/albumDetailHelpers';
import { albumArtistDisplayName, deriveAlbumHeaderArtistRefs } from '@/features/album/utils/deriveAlbumHeaderArtistRefs';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import { albumGridWarmCovers } from '@/cover/layoutSizes';
import { VirtualCardGrid } from '@/ui/VirtualCardGrid';
import LosslessModeBanner from '@/ui/LosslessModeBanner';
import { isLosslessSuffix } from '@/lib/library/losslessFormats';
import { isLosslessMode } from '@/lib/library/losslessMode';
import { readDetailServerId } from '@/lib/navigation/detailServerScope';
import { useOfflineBrowseContext } from '@/features/offline';
import { offlineActionPolicy } from '@/features/offline';
import { resolveIndexKey } from '@/lib/server/serverIndexKey';
import { sameQueueTrack } from '@/features/playback';
import { deriveEntitySourceScopes } from '@/lib/library/libraryBrowseScope';

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
  const setStarredOverride = usePlayerStore(s => s.setStarredOverride);
  const userRatingOverrides = usePlayerStore(s => s.userRatingOverrides);
  const setUserRatingOverride = usePlayerStore(s => s.setUserRatingOverride);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);

  const {
    album, setAlbum, relatedAlbums, loading,
    starredSongs, setStarredSongs,
  } = useAlbumDetailData(id);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [bio, setBio] = useState<string | null>(null);
  const [bioOpen, setBioOpen] = useState(false);
  const bioRequestRef = useRef(0);
  const downloadAlbum = useOfflineStore(s => s.downloadAlbum);
  const deleteAlbum = useOfflineStore(s => s.deleteAlbum);
  const routeServerId = readDetailServerId(searchParams, auth.activeServerId) ?? '';
  const albumOwnerServerId = album?.album.serverId ?? routeServerId;
  const albumOwnerId = album?.album.id ?? '';
  const entitySourceScopes = deriveEntitySourceScopes(auth, albumOwnerServerId);
  const entityRatingSupportByServer = useAuthStore(s => s.entityRatingSupportByServer);
  const setEntityRatingSupport = useAuthStore(s => s.setEntityRatingSupport);
  const albumEntityRatingSupport = entityRatingSupportByServer[albumOwnerServerId] ?? 'unknown';
  const offlineCtx = useOfflineBrowseContext();
  const albumActionPolicy = offlineActionPolicy('albumDetail', offlineCtx.active);
  const userMetadataMutationRef = useRef(false);

  const [filterText, setFilterText] = useState('');
  const [showPlPicker, setShowPlPicker] = useState(false);
  const selectedCount = useSelectionStore(s => s.selectedIds.size);
  const inSelectMode = selectedCount > 0;

  // Derive a stable albumId for the selectors below (empty string when not yet loaded).
  const albumId = albumOwnerId;

  const onReconcileApplied = useCallback((id: string) => {
    usePlayerStore.setState(s => {
      const starredOverrides = { ...s.starredOverrides };
      const userRatingOverrides = { ...s.userRatingOverrides };
      delete starredOverrides[id];
      delete userRatingOverrides[id];
      delete starredOverrides[ownedEntityKey({ id, serverId: albumOwnerServerId })];
      delete userRatingOverrides[ownedEntityKey({ id, serverId: albumOwnerServerId })];
      return { starredOverrides, userRatingOverrides };
    });
  }, [albumOwnerServerId]);

  useAlbumServerMetadataReconcile({
    serverId: albumOwnerServerId,
    albumId,
    album: album?.album,
    setAlbum,
    enabled: !offlineCtx.active,
    userMutationInFlightRef: userMetadataMutationRef,
    onReconcileApplied,
  });

  const isStarred = useMemo(() => {
    if (!albumId) return false;
    const override = ownedOverrideValue(starredOverrides, { id: albumId, serverId: albumOwnerServerId });
    if (override !== undefined) return override;
    return !!album?.album.starred;
  }, [albumId, album?.album.starred, albumOwnerServerId, starredOverrides]);

  const albumEntityRating = useMemo(() => {
    if (!albumId) return 0;
    const override = ownedOverrideValue(userRatingOverrides, { id: albumId, serverId: albumOwnerServerId });
    if (override !== undefined) return override;
    return album?.album.userRating ?? 0;
  }, [albumId, album?.album.userRating, albumOwnerServerId, userRatingOverrides]);

  // React Compiler rule: manual memoization is intentional and must be preserved.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const effectiveSongs = useMemo(() => {
    if (!album?.songs) return undefined;
    if (!losslessOnly) return album.songs;
    return album.songs.filter(s => isLosslessSuffix(s.suffix));
  }, [album?.songs, losslessOnly]);

  const representativeSongs = useMemo(
    () => (effectiveSongs ?? album?.songs ?? []).filter(song => (
      (!song.serverId
        || !albumOwnerServerId
        || resolveIndexKey(song.serverId) === resolveIndexKey(albumOwnerServerId))
      && (!song.albumId || !albumOwnerId || song.albumId === albumOwnerId)
    )),
    [effectiveSongs, album?.songs, albumOwnerId, albumOwnerServerId],
  );
  const offlineSongIds = useMemo(() => representativeSongs.map(s => s.id), [representativeSongs]);
  const { resolvedOfflineStatus, offlineProgress } = useAlbumOfflineState(
    albumId,
    albumOwnerServerId,
    offlineSongIds,
  );

  useEffect(() => {
    if (!albumId || !album || offlineSongIds.length === 0) return;
    let cancelled = false;
    void reconcileLibraryTierForAlbum(
      albumOwnerServerId,
      representativeSongs,
      { kind: 'album', sourceId: albumId, displayName: album.album.name },
    ).then(() => {
      if (cancelled) return;
      if (!isOfflinePinComplete(albumId, albumOwnerServerId, offlineSongIds)) return;
      useOfflineJobStore.setState(s => ({
        jobs: s.jobs.filter(j => j.albumId !== albumId || j.serverId !== albumOwnerServerId),
      }));
    });
    return () => { cancelled = true; };
  }, [albumId, albumOwnerServerId, album, representativeSongs, offlineSongIds]);

  useEffect(() => {
    if (!albumId || representativeSongs.length === 0) return;
    rememberAlbumDistinctDiscCovers(albumId, representativeSongs, albumOwnerServerId);
    return () => forgetAlbumDistinctDiscCovers(albumId, albumOwnerServerId);
  }, [albumId, albumOwnerServerId, representativeSongs]);

  useEffect(() => {
    bioRequestRef.current += 1;
    // React Compiler set-state-in-effect rule: reset route-owned async state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBio(null);
    setBioOpen(false);
  }, [albumOwnerServerId, album?.album.artistId]);

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
      const clickedTrack = songToTrack(song);
      const track = tracks.find(t => sameQueueTrack(t, clickedTrack)) || clickedTrack;
      playTrack(track, tracks);
   };

   const handleDoubleClickSong = (song: SubsonicSong) => addTrackToOrbit(song.id, song.serverId);

  const handleRate = (song: SubsonicSong, rating: number) => {
    setRatings(r => ({ ...r, [ownedEntityKey(song)]: rating }));
    // F4: optimistic override + retried server sync via the central helper.
    queueSongRating(song.id, rating, song.serverId ?? (albumOwnerServerId || undefined));
  };

  const handleAlbumEntityRating = async (rating: number) => {
    if (!album || !albumOwnerServerId) return;
    const albumId = album.album.id;
    const albumOwner = { id: albumId, serverId: albumOwnerServerId };
    const ratingAtStart = ownedOverrideValue(userRatingOverrides, albumOwner)
      ?? album.album.userRating
      ?? 0;

    userMetadataMutationRef.current = true;
    setUserRatingOverride(ownedEntityKey(albumOwner), rating);

    if (albumEntityRatingSupport !== 'full') {
      userMetadataMutationRef.current = false;
      return;
    }

    try {
      await setRating(albumId, rating, { serverId: albumOwnerServerId, kind: 'album' });
      setAlbum(cur =>
        cur && cur.album.id === albumId
          ? { ...cur, album: { ...cur.album, userRating: rating } }
          : cur,
      );
    } catch (err) {
      setUserRatingOverride(ownedEntityKey(albumOwner), ratingAtStart);
      setEntityRatingSupport(albumOwnerServerId, 'track_only');
      showToast(
        typeof err === 'string' ? err : err instanceof Error ? err.message : t('entityRating.saveFailed'),
        4500,
        'error',
      );
    } finally {
      userMetadataMutationRef.current = false;
    }
  };

  const handleBio = async () => {
    if (!album || !albumOwnerServerId) return;
    if (bio) { setBioOpen(true); return; }
    const generation = ++bioRequestRef.current;
    const info = await getArtistInfoForServer(albumOwnerServerId, album.album.artistId);
    if (bioRequestRef.current !== generation) return;
    setBio(info.biography ?? t('albumDetail.noBio'));
    setBioOpen(true);
  };

  const handleDownload = async () => {
    if (!album || !albumOwnerServerId) return;
    const { name, id: albumId } = album.album;

    const folder = auth.downloadFolder || await requestDownloadFolder();
    if (!folder) return;

    const filename = `${sanitizeFilename(name)}.zip`;
    const destPath = await join(folder, filename);
    const url = buildDownloadUrlForServer(albumOwnerServerId, albumId);
    const downloadId = crypto.randomUUID();

    const { start, complete, fail } = useZipDownloadStore.getState();
    start(downloadId, filename);
    try {
      await downloadZip({ id: downloadId, url, destPath });
      complete(downloadId);
    } catch (e) {
      fail(downloadId);
      console.error('ZIP download failed:', e);
    }
  };

  const toggleStar = async () => {
    if (!album || !albumOwnerServerId) return;
    const wasStarred = isStarred;
    const previousStarred = album.album.starred;
    const nextStarred = !wasStarred;
    const albumOwner = { id: album.album.id, serverId: albumOwnerServerId };
    userMetadataMutationRef.current = true;
    setStarredOverride(ownedEntityKey(albumOwner), nextStarred);
    setAlbum(prev => prev ? {
      ...prev,
      album: {
        ...prev.album,
        starred: nextStarred ? (prev.album.starred ?? new Date().toISOString()) : undefined,
      },
    } : prev);
    try {
      const meta = {
        serverId: albumOwnerServerId,
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
      setStarredOverride(ownedEntityKey(albumOwner), wasStarred);
      setAlbum(prev => prev ? {
        ...prev,
        album: {
          ...prev.album,
          starred: wasStarred ? previousStarred : undefined,
        },
      } : prev);
    } finally {
      userMetadataMutationRef.current = false;
    }
  };

  const toggleSongStar = (song: SubsonicSong, e: React.MouseEvent) => {
    e.stopPropagation();
    const songKey = ownedEntityKey(song);
    const wasStarred = starredSongs.has(songKey);
    const next = new Set(starredSongs);
    if (wasStarred) next.delete(songKey); else next.add(songKey);
    setStarredSongs(next);
    // F4: optimistic override + retried server sync via the central helper.
    queueSongStar(song.id, !wasStarred, song.serverId ?? (albumOwnerServerId || undefined));
  };

  const handleCacheOffline = useCallback(async () => {
    if (!album || !albumOwnerServerId) return;
    if (resolvedOfflineStatus === 'queued') {
      dequeueOfflinePin(album.album.id, albumOwnerServerId);
      return;
    }
    let songs = representativeSongs;
    if (shouldAttemptSubsonicForServer(albumOwnerServerId)) {
      try {
        const fresh = await getAlbumForServer(albumOwnerServerId, album.album.id);
        songs = losslessOnly
          ? fresh.songs.filter(s => isLosslessSuffix(s.suffix))
          : fresh.songs;
      } catch {
        /* keep album.songs from the page */
      }
    }
    if (isOfflinePinComplete(album.album.id, albumOwnerServerId, songs.map(s => s.id))) return;
    downloadAlbum(
      album.album.id,
      album.album.name,
      albumArtistDisplayName(album.album),
      album.album.coverArt,
      album.album.year,
      songs,
      albumOwnerServerId,
    );
  }, [album, albumOwnerServerId, downloadAlbum, representativeSongs, losslessOnly, resolvedOfflineStatus]);

  const handleRemoveOffline = () => {
    if (!album || !albumOwnerServerId) return;
    deleteAlbum(album.album.id, albumOwnerServerId);
  };

  // Must be before early returns — hooks must be called unconditionally.
  const mergedStarredSongs = useMemo(() => {
    const merged = new Set<string>();
    for (const song of effectiveSongs ?? album?.songs ?? []) {
      const key = ownedEntityKey(song);
      const override = ownedOverrideValue(starredOverrides, song);
      if (override ?? starredSongs.has(key)) merged.add(key);
    }
    return merged;
  }, [effectiveSongs, album?.songs, starredOverrides, starredSongs]);

  const { sortKey, sortDir, handleSort, displayedSongs } = useAlbumDetailSort({
    songs: effectiveSongs,
    filterText,
    starredSongs: mergedStarredSongs,
    ratings,
    userRatingOverrides,
  });

  const albumCoverServerScope = useMemo(
    () => coverServerScopeForServerId(albumOwnerServerId),
    [albumOwnerServerId],
  );
  const albumCoverRefResolved = useAlbumCoverRef(
    album?.album.id,
    album?.album.coverArt,
    albumCoverServerScope,
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
        serverId={albumOwnerServerId}
        sourceScopes={entitySourceScopes}
        sourceServers={auth.servers}
        sourceMusicFoldersByServer={auth.musicFoldersByServer}
        headerArtistRefs={headerArtistRefs}
        songs={songs}
        coverRef={albumCoverRefResolved}
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
          songs={songs}
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
          {/* Name the artist this grid was actually loaded for (`info.artistId`), not
              the joined credit string and not simply the first ref — the server's
              `artists` order is arbitrary, so the first entry can be a guest while the
              related albums belong to the album artist. */}
          <h2 className="section-title album-related-title">
            {t('albumDetail.moreByArtist', {
              artist: headerArtistRefs.find(ref => ref.id && ref.id === info.artistId)?.name
                ?? headerArtistRefs[0]?.name
                ?? info.artist,
            })}
          </h2>
          <VirtualCardGrid
            items={relatedAlbums}
            itemKey={a => ownedEntityKey(a)}
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
