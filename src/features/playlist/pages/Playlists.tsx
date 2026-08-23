import { resolvePlaylistTracks } from '@/features/playlist/utils/resolvePlaylistTracks';
import { getGenresForServer } from '@/lib/api/subsonicGenres';
import type { SubsonicPlaylist, SubsonicGenre } from '@/lib/api/subsonicTypes';
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
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
import {
  createSmartEditorSession,
  previewRulesFromSession,
  syncSessionFromBasicFilters,
  type SmartEditorSession,
} from '@/features/playlist/utils/smartPlaylistEditor';
import { ndPreviewSmartPlaylist } from '@/lib/api/navidromeSmart';
import { playlistDisplayName } from '@/lib/format/playlistClassification';
import { useSmartCoverCollage } from '@/features/playlist/hooks/useSmartCoverCollage';
import { usePlaylistsLibraryScopeCounts } from '@/features/playlist/hooks/usePlaylistsLibraryScopeCounts';
import { usePendingSmartPolling } from '@/features/playlist/hooks/usePendingSmartPolling';
import { runPlaylistsOpenSmartEditor } from '@/features/playlist/utils/runPlaylistsOpenSmartEditor';
import type { SmartPreviewTrack } from '@/features/playlist/utils/formatSmartPreviewTrack';
import {
  playlistStubFromOpenSmartEditorIntent,
  readOpenSmartEditorIntent,
} from '@/features/playlist/utils/playlistOwnedMutation';
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
import { deriveEffectiveLibraryBrowseServerIds } from '@/lib/library/libraryBrowseScope';
import { useUnavailableServerIds } from '@/lib/network/serverReachability';
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';
import { serverListDisplayLabel } from '@/lib/server/serverDisplayName';

export default function Playlists() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const perfFlags = usePerfProbeFlags();
  const playTrack = usePlayerStore(s => s.playTrack);
  const touchPlaylist = usePlaylistStore((s) => s.touchPlaylist);
  const removeId = usePlaylistStore((s) => s.removeId);
  const playlists = usePlaylistStore((s) => s.playlists);
  const playlistsSearchQuery = useScopedBrowseSearchQuery('playlists');
  const visiblePlaylists = useMemo(
    () => filterPlaylistsByNameQuery(playlists, playlistsSearchQuery),
    [playlists, playlistsSearchQuery],
  );
  const textSearchActive = playlistsSearchQuery.trim().length > 0;
  const fetchPlaylists = usePlaylistStore((s) => s.fetchPlaylists);
  const servers = useAuthStore(s => s.servers);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const subsonicIdentityByServer = useAuthStore(s => s.subsonicServerIdentityByServer);
  const libraryBrowseServerIds = useAuthStore(s => s.libraryBrowseServerIds);
  const libraryBrowseScopeVersion = useAuthStore(s => s.libraryBrowseScopeVersion);
  const unavailableServerIds = useUnavailableServerIds();
  const effectiveServerIds = useMemo(() => deriveEffectiveLibraryBrowseServerIds({
    servers,
    activeServerId,
    libraryBrowseServerIds,
  }, unavailableServerIds), [activeServerId, libraryBrowseServerIds, servers, unavailableServerIds]);
  const serverLabelById = useMemo(() => new Map(
    servers.map(server => [server.id, serverListDisplayLabel(server, servers)]),
  ), [servers]);
  const createServerOptions = useMemo(() => effectiveServerIds.map(serverId => ({
    id: serverId,
    label: serverLabelById.get(serverId) ?? serverId,
  })), [effectiveServerIds, serverLabelById]);
  const smartCreateServerOptions = useMemo(() => createServerOptions.filter(server => (
    (subsonicIdentityByServer[server.id]?.type ?? '').toLowerCase() === 'navidrome'
  )), [createServerOptions, subsonicIdentityByServer]);
  const folderCount = usePlaylistFolderStore(
    s => (activeServerId ? s.byServer[activeServerId]?.folders.length ?? 0 : 0),
  );
  const folderGroupView = usePlaylistFolderStore(s => s.groupView);
  const showFolderView = effectiveServerIds.length === 1
    && effectiveServerIds[0] === activeServerId
    && folderCount > 0
    && folderGroupView;
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const playlistScopeVersion = musicLibraryFilterVersion + libraryBrowseScopeVersion;
  const offlineCtx = useOfflineBrowseContext();
  const offlineBrowseActive = offlineCtx.active;
  const playlistsActionPolicy = offlineActionPolicy('playlistsHeader', offlineCtx.active);

  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [creatingSmart, setCreatingSmart] = useState(false);
  const [newName, setNewName] = useState('');
  const [smartSession, setSmartSession] = useState<SmartEditorSession>(() => createSmartEditorSession());
  const [smartFilters, setSmartFiltersState] = useState<SmartFilters>(defaultSmartFilters);
  const [genres, setGenres] = useState<SubsonicGenre[]>([]);
  const [genresServerId, setGenresServerId] = useState<string | null>(null);
  const [genreQuery, setGenreQuery] = useState('');
  const [creatingSmartBusy, setCreatingSmartBusy] = useState(false);
  const [editingSmartId, setEditingSmartId] = useState<string | null>(null);
  const [editingSmartServerId, setEditingSmartServerId] = useState<string | null>(null);
  const [requestedCreateServerId, setRequestedCreateServerId] = useState<string | null>(null);
  const [pendingSmart, setPendingSmart] = useState<PendingSmartPlaylist[]>([]);
  const smartCoverIdsByPlaylist = useSmartCoverCollage(playlists, playlistScopeVersion);
  const { filteredSongCountByPlaylist, filteredDurationByPlaylist } =
    usePlaylistsLibraryScopeCounts(playlists, playlistScopeVersion);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const smartEditorGenerationRef = useRef(0);
  const smartOperationGenerationRef = useRef(0);

  // ── Multi-selection ──────────────────────────────────────────────────────
  const [selectionMode, setSelectionMode] = useState(false);
  const {
    selectedIds,
    setSelectedIds,
    toggleSelect,
    clearSelection: resetSelection,
  } = useRangeSelection(visiblePlaylists, ownedEntityKey);
  const createServerId = requestedCreateServerId && effectiveServerIds.includes(requestedCreateServerId)
    ? requestedCreateServerId
    : activeServerId && effectiveServerIds.includes(activeServerId)
      ? activeServerId
      : effectiveServerIds[0] ?? '';
  const isNavidromeServer = Boolean(
    createServerId &&
    (subsonicIdentityByServer[createServerId]?.type ?? '').toLowerCase() === 'navidrome',
  );

  // Intersect with the visible list so header/bulk actions never count hidden ids
  // (even for the render before the prune effect below runs).
  const visibleSelectedIds = useMemo(() => {
    if (selectedIds.size === 0) return selectedIds;
    const visibleIds = new Set(visiblePlaylists.map(ownedEntityKey));
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

  const selectedPlaylists = visiblePlaylists.filter(p => visibleSelectedIds.has(ownedEntityKey(p)));
  const isPlaylistDeletable = useCallback((pl: SubsonicPlaylist) => {
    if (!pl.serverId) return false;
    if (!pl.owner) return true;
    const username = servers.find(server => server.id === pl.serverId)?.username;
    return Boolean(username) && pl.owner === username;
  }, [servers]);

  useEffect(() => {
    fetchPlaylists().finally(() => setLoading(false));
  }, [fetchPlaylists, libraryBrowseScopeVersion, offlineBrowseActive]);

  useEffect(() => {
    if (offlineBrowseActive || !createServerId || editingSmartId) return;
    let current = true;
    void getGenresForServer(createServerId)
      .then(nextGenres => {
        if (!current) return;
        setGenres(nextGenres);
        setGenresServerId(createServerId);
      })
      .catch(() => {
        if (!current) return;
        setGenres([]);
        setGenresServerId(createServerId);
      });
    return () => { current = false; };
  }, [createServerId, editingSmartId, offlineBrowseActive]);

  useEffect(() => {
    if (creating) nameInputRef.current?.focus();
  }, [creating]);

  const createPlaylist = usePlaylistStore(s => s.createPlaylist);

  const handleCreate = async () => {
    if (!createServerId) return;
    const name = newName.trim() || t('playlists.unnamed');
    await createPlaylist(name, [], createServerId);
    // Refresh playlists from API to get the new one
    await fetchPlaylists();
    setCreating(false);
    setNewName('');
  };

  const setSmartFilters: React.Dispatch<React.SetStateAction<SmartFilters>> = (action) => {
    setSmartFiltersState(prev => {
      const next = typeof action === 'function' ? action(prev) : action;
      setSmartSession(session => (
        session.mode === 'basic'
          ? syncSessionFromBasicFilters(session, next, {
            allGenres: genres.map(genre => genre.value),
          })
          : { ...session, filters: { ...session.filters, name: next.name } }
      ));
      return next;
    });
  };

  const handleOpenSmartEditor = useCallback(async (pl: SubsonicPlaylist) => {
    const playlistServerId = pl.serverId;
    if (!playlistServerId) return;
    smartOperationGenerationRef.current += 1;
    const generation = ++smartEditorGenerationRef.current;
    const playlistIsNavidrome = Boolean(
      playlistServerId
      && (subsonicIdentityByServer[playlistServerId]?.type ?? '').toLowerCase() === 'navidrome'
    );
    const cachedGenres = genresServerId === playlistServerId ? genres : [];
    void getGenresForServer(playlistServerId)
      .then(nextGenres => {
        if (smartEditorGenerationRef.current !== generation) return;
        setGenres(nextGenres);
        setGenresServerId(playlistServerId);
      })
      .catch(() => {
        if (smartEditorGenerationRef.current !== generation) return;
        setGenres([]);
        setGenresServerId(playlistServerId);
      });
    await runPlaylistsOpenSmartEditor({
      pl, serverId: playlistServerId, isNavidromeServer: playlistIsNavidrome, allGenres: cachedGenres, t,
      setSmartFilters: setSmartFiltersState, setSmartSession, setEditingSmartId, setGenreQuery,
      setCreating, setCreatingSmart, setCreatingSmartBusy,
      setEditingSmartServerId,
      isCurrent: () => smartEditorGenerationRef.current === generation,
    });
  }, [genres, genresServerId, subsonicIdentityByServer, t]);

  useEffect(() => {
    const intent = readOpenSmartEditorIntent(location.state);
    if (!intent) return;
    const pl = playlists.find(p => (
      p.id === intent.id
      && p.serverId === intent.serverId
    )) ?? playlistStubFromOpenSmartEditorIntent(intent);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    void handleOpenSmartEditor(pl);
  }, [location.state, location.pathname, location.search, navigate, playlists, handleOpenSmartEditor]);

  const smartEditorServerId = editingSmartId
    ? editingSmartServerId ?? createServerId
    : createServerId;
  const smartEditorIsNavidrome = editingSmartId
    ? Boolean((subsonicIdentityByServer[smartEditorServerId]?.type ?? '').toLowerCase() === 'navidrome')
    : isNavidromeServer;
  const smartEditorGenres = genresServerId === smartEditorServerId ? genres : [];
  const smartGenresReady = genresServerId === smartEditorServerId;
  const availableGenres = smartEditorGenres
    .map(g => g.value)
    .filter(v => !smartFilters.selectedGenres.includes(v))
    .filter(v => !genreQuery.trim() || v.toLowerCase().includes(genreQuery.trim().toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  const ownerUsername = servers.find(server => server.id === smartEditorServerId)?.username;
  const handleCreateSmart = (saveAsCopy = false) => {
    if (!smartGenresReady) return Promise.resolve();
    const generation = ++smartOperationGenerationRef.current;
    return runPlaylistsSaveSmart({
      isNavidromeServer: smartEditorIsNavidrome, serverId: smartEditorServerId, smartFilters,
      smartSession, allGenres: smartEditorGenres.map(g => g.value), editingSmartId, playlists, fetchPlaylists, t,
      ownerUsername, saveAsCopy,
      setPendingSmart, setCreatingSmart, setEditingSmartId, setSmartFilters: setSmartFiltersState,
      setSmartSession, setGenreQuery, setCreatingSmartBusy, setEditingSmartServerId,
      isCurrent: () => smartOperationGenerationRef.current === generation,
    });
  };

  const handlePreviewSmart = async () => {
    const owner = smartSession.owner || ownerUsername;
    if (!owner) throw new Error('owner required');
    const sessionForPreview = smartSession.mode === 'basic'
      ? { ...smartSession, filters: smartFilters }
      : smartSession;
    const rules = previewRulesFromSession(sessionForPreview, {
      allGenres: smartEditorGenres.map(genre => genre.value),
    });
    const tracks = await ndPreviewSmartPlaylist({
      owner,
      rules,
    }, smartEditorServerId);
    return tracks as SmartPreviewTrack[];
  };

  // Poll until Navidrome materializes tracks (0.63.x refresh-delay window).
  usePendingSmartPolling(pendingSmart, setPendingSmart, fetchPlaylists);

  const handlePlay = async (e: React.MouseEvent, pl: SubsonicPlaylist) => {
    e.stopPropagation();
    const key = ownedEntityKey(pl);
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
      serverLabel={effectiveServerIds.length > 1 && pl.serverId
        ? serverLabelById.get(pl.serverId)
        : undefined}
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
        createServerId={createServerId}
        setCreateServerId={serverId => {
          smartOperationGenerationRef.current += 1;
          smartEditorGenerationRef.current += 1;
          setCreatingSmartBusy(false);
          setRequestedCreateServerId(serverId);
        }}
        createServerOptions={createServerOptions}
        smartCreateServerOptions={smartCreateServerOptions}
        setEditingSmartId={setEditingSmartId}
        setSmartFilters={setSmartFilters}
        setGenreQuery={setGenreQuery}
        onEditorIntent={() => {
          smartOperationGenerationRef.current += 1;
          smartEditorGenerationRef.current += 1;
          setCreatingSmartBusy(false);
          setSmartSession(createSmartEditorSession());
        }}
        actionPolicy={playlistsActionPolicy}
        foldersEnabled={effectiveServerIds.length === 1 && effectiveServerIds[0] === activeServerId}
      />

      {creatingSmart && (
        <PlaylistsSmartEditor
          session={smartSession}
          setSession={setSmartSession}
          smartFilters={smartFilters}
          setSmartFilters={setSmartFilters}
          availableGenres={availableGenres}
          genreQuery={genreQuery}
          setGenreQuery={setGenreQuery}
          editingSmartId={editingSmartId}
          creatingSmartBusy={creatingSmartBusy}
          genresReady={smartGenresReady}
          createServerId={smartEditorServerId}
          setCreateServerId={serverId => {
            smartOperationGenerationRef.current += 1;
            smartEditorGenerationRef.current += 1;
            setCreatingSmartBusy(false);
            setRequestedCreateServerId(serverId);
          }}
          createServerOptions={smartCreateServerOptions}
          setCreatingSmart={setCreatingSmart}
          setEditingSmartId={setEditingSmartId}
          onSave={() => { void handleCreateSmart(false); }}
          onSaveCopy={() => { void handleCreateSmart(true); }}
          onResetToServer={() => {
            const pl = playlists.find(item => item.id === editingSmartId && item.serverId === smartEditorServerId);
            if (pl) void handleOpenSmartEditor(pl);
          }}
          onPreview={handlePreviewSmart}
          serverIdentity={subsonicIdentityByServer[smartEditorServerId]}
          playlistOptions={playlists
            .filter(item => item.serverId === smartEditorServerId)
            .map(item => ({ id: item.id, name: playlistDisplayName(item) }))}
          ownerUsername={ownerUsername}
          onCancel={() => {
            smartOperationGenerationRef.current += 1;
            smartEditorGenerationRef.current += 1;
            setCreatingSmartBusy(false);
          }}
        />
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
          {showFolderView && activeServerId ? (
            <PlaylistsFolderView
              serverId={activeServerId}
              playlists={visiblePlaylists}
              renderCard={renderCard}
              disableVirtualization={perfFlags.disableMainstageVirtualLists}
              hideEmptyFolders={textSearchActive}
            />
          ) : (
            <VirtualCardGrid
              items={visiblePlaylists}
              itemKey={(pl, _i) => ownedEntityKey(pl)}
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
