import { resolveMediaServerId, resolvePlaylist } from '../utils/offline/offlineMediaResolve';
import { getGenres } from '../api/subsonicGenres';
import { filterSongsToActiveLibrary } from '../api/subsonicLibrary';
import type { SubsonicPlaylist, SubsonicGenre } from '../api/subsonicTypes';
import { songToTrack } from '../utils/playback/songToTrack';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { usePlayerStore } from '../store/playerStore';
import { usePlaylistStore } from '../store/playlistStore';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from 'react-i18next';
import { useRangeSelection } from '../hooks/useRangeSelection';

import {
  defaultSmartFilters,
  type SmartFilters, type PendingSmartPlaylist,
} from '../utils/playlist/playlistsSmart';
import { useSmartCoverCollage } from '../hooks/useSmartCoverCollage';
import { usePlaylistsLibraryScopeCounts } from '../hooks/usePlaylistsLibraryScopeCounts';
import { usePendingSmartPolling } from '../hooks/usePendingSmartPolling';
import { runPlaylistsOpenSmartEditor } from '../utils/playlist/runPlaylistsOpenSmartEditor';
import { runPlaylistsSaveSmart } from '../utils/playlist/runPlaylistsSaveSmart';
import {
  runPlaylistDelete, runPlaylistDeleteSelected,
} from '../utils/playlist/runPlaylistsActions';
import PlaylistsSmartEditor from '../components/playlists/PlaylistsSmartEditor';
import PlaylistsHeader from '../components/playlists/PlaylistsHeader';
import PlaylistCard from '../components/playlists/PlaylistCard';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import { useOfflineBrowseContext } from '../hooks/useOfflineBrowseContext';
import { offlineActionPolicy } from '../utils/offline/offlineActionPolicy';
import { Info } from 'lucide-react';
import PlaylistsFolderView from '../components/playlists/PlaylistsFolderView';
import { usePlaylistFolderStore } from '../store/playlistFolderStore';

export default function Playlists() {
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const playTrack = usePlayerStore(s => s.playTrack);
  const touchPlaylist = usePlaylistStore((s) => s.touchPlaylist);
  const removeId = usePlaylistStore((s) => s.removeId);
  const playlists = usePlaylistStore((s) => s.playlists);
  const fetchPlaylists = usePlaylistStore((s) => s.fetchPlaylists);
  const activeUsername = useAuthStore(s => s.getActiveServer()?.username ?? '');
  const activeServerId = useAuthStore(s => s.activeServerId);
  const folderCount = usePlaylistFolderStore(
    s => (activeServerId ? s.byServer[activeServerId]?.folders.length ?? 0 : 0),
  );
  const folderGroupView = usePlaylistFolderStore(s => s.groupView);
  const showFolderView = Boolean(activeServerId) && folderCount > 0 && folderGroupView;
  const subsonicIdentityByServer = useAuthStore(s => s.subsonicServerIdentityByServer);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const offlineCtx = useOfflineBrowseContext();
  const offlineBrowseActive = offlineCtx.active;
  const playlistsActionPolicy = offlineActionPolicy('playlistsHeader', offlineCtx.active);

  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [creatingSmart, setCreatingSmart] = useState(false);
  const [newName, setNewName] = useState('');
  const [smartFilters, setSmartFilters] = useState<SmartFilters>(defaultSmartFilters);
  const [genres, setGenres] = useState<SubsonicGenre[]>([]);
  const [genreQuery, setGenreQuery] = useState('');
  const [creatingSmartBusy, setCreatingSmartBusy] = useState(false);
  const [editingSmartId, setEditingSmartId] = useState<string | null>(null);
  const [pendingSmart, setPendingSmart] = useState<PendingSmartPlaylist[]>([]);
  const smartCoverIdsByPlaylist = useSmartCoverCollage(playlists, musicLibraryFilterVersion);
  const { filteredSongCountByPlaylist, filteredDurationByPlaylist } =
    usePlaylistsLibraryScopeCounts(playlists, musicLibraryFilterVersion);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // ── Multi-selection ──────────────────────────────────────────────────────
  const [selectionMode, setSelectionMode] = useState(false);
  const { selectedIds, toggleSelect, clearSelection: resetSelection } = useRangeSelection(playlists);
  const isNavidromeServer = Boolean(
    activeServerId &&
    (subsonicIdentityByServer[activeServerId]?.type ?? '').toLowerCase() === 'navidrome',
  );

  const toggleSelectionMode = () => {
    setSelectionMode(v => !v);
    resetSelection();
  };

  const clearSelection = () => {
    setSelectionMode(false);
    resetSelection();
  };

  const selectedPlaylists = playlists.filter(p => selectedIds.has(p.id));
  const isPlaylistDeletable = useCallback((pl: SubsonicPlaylist) => {
    if (!pl.owner) return true;
    if (!activeUsername) return false;
    return pl.owner === activeUsername;
  }, [activeUsername]);

  useEffect(() => {
    fetchPlaylists().finally(() => setLoading(false));
    if (!offlineBrowseActive) {
      getGenres().then(setGenres).catch(() => {});
    }
  }, [fetchPlaylists, offlineBrowseActive]);

  useEffect(() => {
    if (creating) nameInputRef.current?.focus();
  }, [creating]);

  const createPlaylist = usePlaylistStore(s => s.createPlaylist);

  const availableGenres = genres
    .map(g => g.value)
    .filter(v => !smartFilters.selectedGenres.includes(v))
    .filter(v => !genreQuery.trim() || v.toLowerCase().includes(genreQuery.trim().toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  const handleCreate = async () => {
    const name = newName.trim() || t('playlists.unnamed');
    await createPlaylist(name);
    // Refresh playlists from API to get the new one
    await fetchPlaylists();
    setCreating(false);
    setNewName('');
  };

  const handleOpenSmartEditor = (pl: SubsonicPlaylist) => runPlaylistsOpenSmartEditor({
    pl, isNavidromeServer, allGenres: genres, t,
    setSmartFilters, setEditingSmartId, setGenreQuery,
    setCreating, setCreatingSmart, setCreatingSmartBusy,
  });

  const handleCreateSmart = () => runPlaylistsSaveSmart({
    isNavidromeServer, smartFilters, allGenres: genres.map(g => g.value), editingSmartId, playlists, fetchPlaylists, t,
    setPendingSmart, setCreatingSmart, setEditingSmartId, setSmartFilters,
    setGenreQuery, setCreatingSmartBusy,
  });

  // Smart playlist rules are processed asynchronously on server.
  usePendingSmartPolling(pendingSmart, setPendingSmart, fetchPlaylists);

  const handlePlay = async (e: React.MouseEvent, pl: SubsonicPlaylist) => {
    e.stopPropagation();
    if (playingId === pl.id) return;
    setPlayingId(pl.id);
    try {
      const serverId = resolveMediaServerId(activeServerId);
      if (!serverId) return;
      const data = await resolvePlaylist(serverId, pl.id);
      if (!data) return;
      const songs = offlineBrowseActive
        ? data.songs
        : await filterSongsToActiveLibrary(data.songs);
      const tracks = songs.map(songToTrack);
      if (tracks.length > 0) {
        touchPlaylist(pl.id);
        playTrack(tracks[0], tracks);
      }
    } catch { /* ignore: best-effort */ }
    setPlayingId(null);
  };

  const handleDelete = (e: React.MouseEvent, pl: SubsonicPlaylist) => runPlaylistDelete({
    e, pl, deleteConfirmId, setDeleteConfirmId, removeId, t,
  });

  const handleDeleteSelected = () => runPlaylistDeleteSelected({
    selectedPlaylists, selectedIds, isPlaylistDeletable, removeId, clearSelection, t,
  });

  const renderCard = (pl: SubsonicPlaylist) => (
    <PlaylistCard
      pl={pl}
      selectionMode={selectionMode}
      draggable={showFolderView}
      selectedIds={selectedIds}
      selectedPlaylists={selectedPlaylists}
      toggleSelect={toggleSelect}
      isPlaylistDeletable={isPlaylistDeletable}
      deleteConfirmId={deleteConfirmId}
      setDeleteConfirmId={setDeleteConfirmId}
      handleOpenSmartEditor={handleOpenSmartEditor}
      handleDelete={handleDelete}
      handlePlay={handlePlay}
      playingId={playingId}
      smartCoverIdsByPlaylist={smartCoverIdsByPlaylist}
      pendingSmart={pendingSmart}
      filteredSongCountByPlaylist={filteredSongCountByPlaylist}
      filteredDurationByPlaylist={filteredDurationByPlaylist}
    />
  );

  if (loading) {
    return (
      <div className="content-body" style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="content-body animate-fade-in">
      <style>{`
        .dual-year-range {
          position: relative;
          height: 34px;
        }
        .dual-year-range__track,
        .dual-year-range__selected {
          position: absolute;
          left: 0;
          right: 0;
          top: 50%;
          height: 4px;
          transform: translateY(-50%);
          border-radius: 999px;
        }
        .dual-year-range__track { background: var(--border); }
        .dual-year-range__selected { background: var(--accent); }
        .dual-year-range input[type='range'] {
          position: absolute;
          left: 0;
          top: 0;
          width: 100%;
          height: 34px;
          margin: 0;
          background: transparent;
          -webkit-appearance: none;
          appearance: none;
          pointer-events: none;
        }
        .dual-year-range input[type='range']::-webkit-slider-runnable-track { height: 4px; background: transparent; }
        .dual-year-range input[type='range']::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          margin-top: -5px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--bg-card);
          pointer-events: auto;
          cursor: pointer;
        }
      `}</style>

      <PlaylistsHeader
        selectionMode={selectionMode}
        selectedIds={selectedIds}
        selectedPlaylists={selectedPlaylists}
        isPlaylistDeletable={isPlaylistDeletable}
        toggleSelectionMode={toggleSelectionMode}
        handleDeleteSelected={handleDeleteSelected}
        creating={creating}
        setCreating={setCreating}
        setCreatingSmart={setCreatingSmart}
        newName={newName}
        setNewName={setNewName}
        nameInputRef={nameInputRef}
        handleCreate={handleCreate}
        isNavidromeServer={isNavidromeServer}
        setEditingSmartId={setEditingSmartId}
        setSmartFilters={setSmartFilters}
        setGenreQuery={setGenreQuery}
        actionPolicy={playlistsActionPolicy}
      />

      {creatingSmart && (
        <PlaylistsSmartEditor
          smartFilters={smartFilters}
          setSmartFilters={setSmartFilters}
          availableGenres={availableGenres}
          genreQuery={genreQuery}
          setGenreQuery={setGenreQuery}
          editingSmartId={editingSmartId}
          creatingSmartBusy={creatingSmartBusy}
          setCreatingSmart={setCreatingSmart}
          setEditingSmartId={setEditingSmartId}
          onSave={handleCreateSmart}
        />
      )}

      {/* ── Grid ── */}
      {playlists.length === 0 ? (
        <div className="empty-state">{t('playlists.empty')}</div>
      ) : (
        <>
          {showFolderView && (
            <p className="playlist-folder-notice playlist-folder-notice--page">
              <Info size={13} /> {t('playlists.folders.localOnlyNotice')}
            </p>
          )}
          {showFolderView && activeServerId ? (
            <PlaylistsFolderView
              serverId={activeServerId}
              playlists={playlists}
              renderCard={renderCard}
              disableVirtualization={perfFlags.disableMainstageVirtualLists}
            />
          ) : (
            <VirtualCardGrid
              items={playlists}
              itemKey={(pl, _i) => pl.id}
              rowVariant="playlist"
              disableVirtualization={perfFlags.disableMainstageVirtualLists}
              layoutSignal={playlists.length}
              renderItem={renderCard}
            />
          )}
        </>
      )}


    </div>
  );
}
