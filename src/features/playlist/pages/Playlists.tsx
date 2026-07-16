import { resolvePlaylistTracks } from '@/features/playlist/utils/resolvePlaylistTracks';
import { getGenres } from '@/lib/api/subsonicGenres';
import type { SubsonicPlaylist, SubsonicGenre } from '@/lib/api/subsonicTypes';
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { usePlaylistStore } from '@/features/playlist/store/playlistStore';
import { useAuthStore } from '@/store/authStore';
import { useTranslation } from 'react-i18next';
import { useRangeSelection } from '@/lib/hooks/useRangeSelection';
import { useScopedBrowseSearchQuery } from '@/store/liveSearchScopeStore';
import { filterPlaylistsByNameQuery } from '@/features/playlist/utils/playlistsBrowseSearch';

import {
  defaultSmartFilters,
  type SmartFilters, type PendingSmartPlaylist,
} from '@/features/playlist/utils/playlistsSmart';
import { useSmartCoverCollage } from '@/features/playlist/hooks/useSmartCoverCollage';
import { usePlaylistsLibraryScopeCounts } from '@/features/playlist/hooks/usePlaylistsLibraryScopeCounts';
import { usePendingSmartPolling } from '@/features/playlist/hooks/usePendingSmartPolling';
import { runPlaylistsOpenSmartEditor } from '@/features/playlist/utils/runPlaylistsOpenSmartEditor';
import { runPlaylistsSaveSmart } from '@/features/playlist/utils/runPlaylistsSaveSmart';
import {
  runPlaylistDelete, runPlaylistDeleteSelected,
} from '@/features/playlist/utils/runPlaylistsActions';
import PlaylistsSmartEditor from '@/features/playlist/components/PlaylistsSmartEditor';
import PlaylistsHeader from '@/features/playlist/components/PlaylistsHeader';
import PlaylistCard from '@/features/playlist/components/PlaylistCard';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import { VirtualCardGrid } from '@/ui/VirtualCardGrid';
import { useOfflineBrowseContext } from '@/features/offline';
import { offlineActionPolicy } from '@/features/offline';
import { Info } from 'lucide-react';
import PlaylistsFolderView from '@/features/playlist/components/PlaylistsFolderView';
import { usePlaylistFolderStore } from '@/features/playlist/store/playlistFolderStore';
import { libraryEntityKey } from '@/lib/library/libraryEntityKey';
import { useReachableLibrarySources } from '@/store/useReachableLibrarySources';

export default function Playlists() {
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const playTrack = usePlayerStore(s => s.playTrack);
  const touchPlaylist = usePlaylistStore((s) => s.touchPlaylist);
  const removeId = usePlaylistStore((s) => s.removeId);
  const playlists = usePlaylistStore((s) => s.playlists);
  const reachableSources = useReachableLibrarySources();
  const reachableIds = useMemo(() => new Set(reachableSources.map(source => source.serverId)), [reachableSources]);
  const playlistsSearchQuery = useScopedBrowseSearchQuery('playlists');
  const visiblePlaylists = useMemo(
    () => filterPlaylistsByNameQuery(
      playlists.filter(playlist => !playlist.serverId || reachableIds.has(playlist.serverId)),
      playlistsSearchQuery,
    ),
    [playlists, playlistsSearchQuery, reachableIds],
  );
  const textSearchActive = playlistsSearchQuery.trim().length > 0;
  const fetchPlaylists = usePlaylistStore((s) => s.fetchPlaylists);
  const refreshReachablePlaylists = useCallback(
    () => fetchPlaylists(reachableSources.map(source => source.serverId)),
    [fetchPlaylists, reachableSources],
  );
  const activeServerId = useAuthStore(s => s.activeServerId);
  const servers = useAuthStore(s => s.servers);
  const foldersByServer = usePlaylistFolderStore(s => s.byServer);
  const folderCount = reachableSources.reduce(
    (count, source) => count + (foldersByServer[source.serverId]?.folders.length ?? 0),
    0,
  );
  const folderGroupView = usePlaylistFolderStore(s => s.groupView);
  const showFolderView = folderCount > 0 && folderGroupView;
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
  const {
    selectedIds,
    setSelectedIds,
    toggleSelect,
    clearSelection: resetSelection,
  } = useRangeSelection(visiblePlaylists, libraryEntityKey);
  const isNavidromeServer = Boolean(
    activeServerId &&
    (subsonicIdentityByServer[activeServerId]?.type ?? '').toLowerCase() === 'navidrome',
  );

  // Intersect with the visible list so header/bulk actions never count hidden ids
  // (even for the render before the prune effect below runs).
  const visibleSelectedIds = useMemo(() => {
    if (selectedIds.size === 0) return selectedIds;
    const visibleIds = new Set(visiblePlaylists.map(libraryEntityKey));
    let changed = false;
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (visibleIds.has(id)) next.add(id);
      else changed = true;
    }
    return changed ? next : selectedIds;
  }, [selectedIds, visiblePlaylists]);

  // Drop ids that the scoped search hid so range-select state stays coherent.
  useEffect(() => {
    if (visibleSelectedIds === selectedIds) return;
    setSelectedIds(visibleSelectedIds);
  }, [visibleSelectedIds, selectedIds, setSelectedIds]);

  const toggleSelectionMode = () => {
    setSelectionMode(v => !v);
    resetSelection();
  };

  const clearSelection = () => {
    setSelectionMode(false);
    resetSelection();
  };

  const selectedPlaylists = visiblePlaylists.filter(p => visibleSelectedIds.has(libraryEntityKey(p)));
  const isPlaylistDeletable = useCallback((pl: SubsonicPlaylist) => {
    if (!pl.owner) return true;
    const ownerUsername = servers.find(server => server.id === pl.serverId)?.username ?? '';
    return Boolean(ownerUsername) && pl.owner === ownerUsername;
  }, [servers]);

  useEffect(() => {
    refreshReachablePlaylists().finally(() => setLoading(false));
    if (!offlineBrowseActive) {
      getGenres().then(setGenres).catch(() => {});
    }
  }, [offlineBrowseActive, refreshReachablePlaylists]);

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
    await refreshReachablePlaylists();
    setCreating(false);
    setNewName('');
  };

  const handleOpenSmartEditor = (pl: SubsonicPlaylist) => {
    const ownerServerId = pl.serverId ?? '';
    const ownerServerName = servers.find(server => server.id === ownerServerId)?.name ?? ownerServerId;
    const isOwnerNavidrome = Boolean(
      ownerServerId && (subsonicIdentityByServer[ownerServerId]?.type ?? '').toLowerCase() === 'navidrome',
    );
    return runPlaylistsOpenSmartEditor({
      pl,
      ownerServerId,
      activeServerId: activeServerId ?? '',
      isOwnerNavidrome,
      ownerServerName,
      allGenres: genres,
      t,
      setSmartFilters,
      setEditingSmartId,
      setGenreQuery,
      setCreating,
      setCreatingSmart,
      setCreatingSmartBusy,
    });
  };

  const handleCreateSmart = () => runPlaylistsSaveSmart({
    ownerServerId: activeServerId ?? '',
    isNavidromeServer,
    smartFilters,
    allGenres: genres.map(g => g.value),
    editingSmartId,
    playlists,
    fetchPlaylists: refreshReachablePlaylists,
    t,
    setPendingSmart,
    setCreatingSmart,
    setEditingSmartId,
    setSmartFilters,
    setGenreQuery,
    setCreatingSmartBusy,
  });

  // Smart playlist rules are processed asynchronously on server.
  usePendingSmartPolling(pendingSmart, setPendingSmart, refreshReachablePlaylists);

  const handlePlay = async (e: React.MouseEvent, pl: SubsonicPlaylist) => {
    e.stopPropagation();
    const key = libraryEntityKey(pl);
    if (playingId === key) return;
    setPlayingId(key);
    try {
      const tracks = await resolvePlaylistTracks(pl.id, pl.serverId);
      if (tracks.length > 0) {
        touchPlaylist(pl.id, pl.serverId);
        playTrack(tracks[0], tracks);
      }
    } catch { /* ignore: best-effort */ }
    setPlayingId(null);
  };

  const handleDelete = (e: React.MouseEvent, pl: SubsonicPlaylist) => runPlaylistDelete({
    e, pl, deleteConfirmId, setDeleteConfirmId, removeId, t,
  });

  const handleDeleteSelected = () => runPlaylistDeleteSelected({
    selectedPlaylists, isPlaylistDeletable, removeId, clearSelection, t,
  });

  const renderCard = (pl: SubsonicPlaylist) => (
    <PlaylistCard
      pl={pl}
      selectionMode={selectionMode}
      draggable={showFolderView}
      selectedIds={visibleSelectedIds}
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
        selectedIds={visibleSelectedIds}
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

      {reachableSources.length > 1 && (
        <div className="source-group-list" aria-label={t('playlists.sources')}>
          {reachableSources.map(source => (
            <span key={source.serverId} className="source-group-label">{source.name}</span>
          ))}
        </div>
      )}

      {/* ── Grid ── */}
      {playlists.length === 0 ? (
        <div className="empty-state">{t('playlists.empty')}</div>
      ) : visiblePlaylists.length === 0 && textSearchActive ? (
        <div className="empty-state">{t('playlists.noMatchingSearch')}</div>
      ) : (
        <>
          {showFolderView && (
            <p className="playlist-folder-notice playlist-folder-notice--page">
              <Info size={13} /> {t('playlists.folders.localOnlyNotice')}
            </p>
          )}
          {showFolderView ? (
            reachableSources.map(source => {
              const sourcePlaylists = visiblePlaylists.filter(playlist => playlist.serverId === source.serverId);
              if (sourcePlaylists.length === 0 && textSearchActive) return null;
              return (
                <section key={source.serverId} className="source-group-section">
                  {reachableSources.length > 1 && <h2 className="source-group-label">{source.name}</h2>}
                  <PlaylistsFolderView
                    serverId={source.serverId}
                    playlists={sourcePlaylists}
                    renderCard={renderCard}
                    disableVirtualization={perfFlags.disableMainstageVirtualLists}
                    hideEmptyFolders={textSearchActive}
                  />
                </section>
              );
            })
          ) : (
            <VirtualCardGrid
              items={visiblePlaylists}
              itemKey={(pl, _i) => libraryEntityKey(pl)}
              rowVariant="playlist"
              disableVirtualization={perfFlags.disableMainstageVirtualLists}
              layoutSignal={visiblePlaylists.length}
              renderItem={renderCard}
            />
          )}
        </>
      )}


    </div>
  );
}
