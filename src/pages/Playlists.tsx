import { deletePlaylist, getPlaylist, updatePlaylist } from '../api/subsonicPlaylists';
import { getGenres } from '../api/subsonicGenres';
import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import { filterSongsToActiveLibrary } from '../api/subsonicLibrary';
import type { SubsonicPlaylist, SubsonicGenre } from '../api/subsonicTypes';
import { songToTrack } from '../utils/songToTrack';
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListMusic, Play, Plus, Trash2, CheckSquare2, Check, Clock3, Sparkles, Pencil } from 'lucide-react';
import { usePlayerStore } from '../store/playerStore';
import { usePlaylistStore } from '../store/playlistStore';
import { useAuthStore } from '../store/authStore';
import CachedImage from '../components/CachedImage';
import StarRating from '../components/StarRating';
import { useTranslation } from 'react-i18next';
import { formatHumanHoursMinutes } from '../utils/formatHumanDuration';
import { showToast } from '../utils/toast';
import { useRangeSelection } from '../hooks/useRangeSelection';

import {
  defaultSmartFilters, displayPlaylistName, isSmartPlaylistName,
  type SmartFilters, type PendingSmartPlaylist,
} from '../utils/playlistsSmart';
import { PlaylistSmartCoverCell, PlaylistCardMainCover } from '../components/playlists/PlaylistCoverImages';
import { useSmartCoverCollage } from '../hooks/useSmartCoverCollage';
import { usePlaylistsLibraryScopeCounts } from '../hooks/usePlaylistsLibraryScopeCounts';
import { usePendingSmartPolling } from '../hooks/usePendingSmartPolling';
import { runPlaylistsOpenSmartEditor } from '../utils/runPlaylistsOpenSmartEditor';
import { runPlaylistsSaveSmart } from '../utils/runPlaylistsSaveSmart';
import PlaylistsSmartEditor from '../components/playlists/PlaylistsSmartEditor';

function formatDuration(seconds: number): string {
  return formatHumanHoursMinutes(seconds);
}

export default function Playlists() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const playTrack = usePlayerStore(s => s.playTrack);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const touchPlaylist = usePlaylistStore((s) => s.touchPlaylist);
  const removeId = usePlaylistStore((s) => s.removeId);
  const playlists = usePlaylistStore((s) => s.playlists);
  const fetchPlaylists = usePlaylistStore((s) => s.fetchPlaylists);
  const playlistsLoading = usePlaylistStore((s) => s.playlistsLoading);
  const activeUsername = useAuthStore(s => s.getActiveServer()?.username ?? '');
  const activeServerId = useAuthStore(s => s.activeServerId);
  const subsonicIdentityByServer = useAuthStore(s => s.subsonicServerIdentityByServer);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

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
    getGenres().then(setGenres).catch(() => {});
  }, [fetchPlaylists]);

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
    pl, isNavidromeServer, t,
    setSmartFilters, setEditingSmartId, setGenreQuery,
    setCreating, setCreatingSmart, setCreatingSmartBusy,
  });

  const handleCreateSmart = () => runPlaylistsSaveSmart({
    isNavidromeServer, smartFilters, editingSmartId, playlists, fetchPlaylists, t,
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
      const data = await getPlaylist(pl.id);
      const filteredSongs = await filterSongsToActiveLibrary(data.songs);
      const tracks = filteredSongs.map(songToTrack);
      if (tracks.length > 0) {
        touchPlaylist(pl.id);
        playTrack(tracks[0], tracks);
      }
    } catch {}
    setPlayingId(null);
  };

  const handleDelete = async (e: React.MouseEvent, pl: SubsonicPlaylist) => {
    e.stopPropagation();
    if (deleteConfirmId !== pl.id) {
      setDeleteConfirmId(pl.id);
      const btn = e.currentTarget as HTMLElement;
      requestAnimationFrame(() => {
        btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      return;
    }
    try {
      await deletePlaylist(pl.id);
      removeId(pl.id);
      usePlaylistStore.setState((s) => ({
        playlists: s.playlists.filter((p) => p.id !== pl.id),
      }));
      showToast(t('playlists.deleteSuccess', { count: 1 }), 3000, 'info');
    } catch {
      showToast(t('playlists.deleteFailed', { name: pl.name }), 3000, 'error');
    }
    setDeleteConfirmId(null);
  };

  const handleDeleteSelected = async () => {
    const deletable = selectedPlaylists.filter(isPlaylistDeletable);
    if (deletable.length === 0) return;
    let deleted = 0;
    for (const pl of deletable) {
      try {
        await deletePlaylist(pl.id);
        removeId(pl.id);
        deleted++;
      } catch {
        showToast(t('playlists.deleteFailed', { name: pl.name }), 3000, 'error');
      }
    }
    usePlaylistStore.setState((s) => ({
      playlists: s.playlists.filter((p) => !(selectedIds.has(p.id) && isPlaylistDeletable(p))),
    }));
    clearSelection();
    if (deleted > 0) {
      showToast(t('playlists.deleteSuccess', { count: deleted }), 3000, 'info');
    }
  };

  const handleMergeSelected = async (targetPlaylist: SubsonicPlaylist) => {
    if (selectedPlaylists.length === 0) return;
    try {
      const { songs: targetSongs } = await getPlaylist(targetPlaylist.id);
      const targetIds = new Set(targetSongs.map(s => s.id));
      let totalAdded = 0;

      for (const pl of selectedPlaylists) {
        if (pl.id === targetPlaylist.id) continue;
        const { songs } = await getPlaylist(pl.id);
        const newSongs = songs.filter(s => !targetIds.has(s.id));
        if (newSongs.length > 0) {
          newSongs.forEach(s => targetIds.add(s.id));
          totalAdded += newSongs.length;
        }
      }

      if (totalAdded > 0) {
        await updatePlaylist(targetPlaylist.id, Array.from(targetIds));
        touchPlaylist(targetPlaylist.id);
        showToast(t('playlists.mergeSuccess', { count: totalAdded, playlist: targetPlaylist.name }), 3000, 'info');
      } else {
        showToast(t('playlists.mergeNoNewSongs'), 3000, 'info');
      }
      clearSelection();
    } catch {
      showToast(t('playlists.mergeError'), 4000, 'error');
    }
  };

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

      {/* ── Header row ── */}
      <div className="playlists-header">
        <h1 className="page-title" style={{ marginBottom: 0 }}>
          {selectionMode && selectedIds.size > 0
            ? t('playlists.selectionCount', { count: selectedIds.size })
            : t('playlists.title')}
        </h1>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {!(selectionMode && selectedIds.size > 0) && (<>
              {creating ? (
                <>
                  <input
                    ref={nameInputRef}
                    className="input"
                    style={{ width: 220 }}
                    placeholder={t('playlists.createName')}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreate();
                      if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                    }}
                  />
                  <button className="btn btn-primary" onClick={handleCreate}>
                    {t('playlists.create')}
                  </button>
                  <button className="btn btn-surface" onClick={() => { setCreating(false); setNewName(''); }}>
                    {t('playlists.cancel')}
                  </button>
                </>
              ) : (
                <button className="btn btn-primary" onClick={() => { setCreatingSmart(false); setCreating(true); }}>
                  <Plus size={15} /> {t('playlists.newPlaylist')}
                </button>
              )}
              {!creating && isNavidromeServer && (
                <button className="btn btn-surface" onClick={() => {
                  setCreating(false);
                  setEditingSmartId(null);
                  setSmartFilters(defaultSmartFilters);
                  setGenreQuery('');
                  setCreatingSmart(v => !v);
                }}>
                  <Plus size={15} /> {t('smartPlaylists.create')}
                </button>
              )}
            </>
          )}
          {selectionMode && selectedIds.size > 0 && (() => {
            const deletableCount = selectedPlaylists.filter(isPlaylistDeletable).length;
            return (
              <button
                className="btn btn-danger"
                onClick={handleDeleteSelected}
                disabled={deletableCount === 0}
                data-tooltip={deletableCount === selectedIds.size
                  ? undefined
                  : t('playlists.deleteSelectedPartial', { n: deletableCount, total: selectedIds.size })}
                data-tooltip-pos="bottom"
              >
                <Trash2 size={15} />
                {t('playlists.deleteSelected')}
              </button>
            );
          })()}
          <button
            className={`btn btn-surface${selectionMode ? ' btn-sort-active' : ''}`}
            onClick={toggleSelectionMode}
            data-tooltip={selectionMode ? t('playlists.cancelSelect') : t('playlists.startSelect')}
            data-tooltip-pos="bottom"
            style={selectionMode ? { background: 'var(--accent)', color: 'var(--ctp-crust)' } : {}}
          >
            <CheckSquare2 size={15} />
            {selectionMode ? t('playlists.cancelSelect') : t('playlists.select')}
          </button>
        </div>
      </div>
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
        <div className="album-grid-wrap">
          {playlists.map((pl) => (
            <div
              key={pl.id}
              className={`album-card${selectionMode && selectedIds.has(pl.id) ? ' selected' : ''}`}
              onClick={(e) => {
                if (selectionMode) {
                  toggleSelect(pl.id, { shiftKey: e.shiftKey });
                } else {
                  navigate(`/playlists/${pl.id}`);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (selectionMode && selectedIds.size > 0) {
                  openContextMenu(e.clientX, e.clientY, selectedPlaylists, 'multi-playlist');
                } else {
                  openContextMenu(e.clientX, e.clientY, pl, 'playlist');
                }
              }}
              onMouseLeave={() => { if (deleteConfirmId === pl.id) setDeleteConfirmId(null); }}
              style={selectionMode && selectedIds.has(pl.id) ? {
                position: 'relative',
                outline: '2px solid var(--accent)',
                outlineOffset: '2px',
                borderRadius: 'var(--radius-md)'
              } : { position: 'relative' }}
            >
              {!selectionMode && (
                <div className="playlist-card-actions">
                  {isPlaylistDeletable(pl) && (
                    <button
                      className="playlist-card-action playlist-card-action--edit"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isSmartPlaylistName(pl.name)) {
                          void handleOpenSmartEditor(pl);
                          return;
                        }
                        navigate(`/playlists/${pl.id}`, { state: { openEditMeta: true } });
                      }}
                      data-tooltip={t('playlists.editMeta')}
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  {isPlaylistDeletable(pl) && (
                    <button
                      className={`playlist-card-action playlist-card-action--delete${deleteConfirmId === pl.id ? ' playlist-card-action--delete-confirm' : ''}`}
                      onClick={(e) => handleDelete(e, pl)}
                      data-tooltip={deleteConfirmId === pl.id ? t('playlists.confirmDelete') : t('common.delete')}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              )}
              {selectionMode && (
                <div className={`album-card-select-check${selectedIds.has(pl.id) ? ' album-card-select-check--on' : ''}`}>
                  {selectedIds.has(pl.id) && <Check size={14} strokeWidth={3} />}
                </div>
              )}
              {/* Cover area — server collage or fallback icon */}
              <div className="album-card-cover">
                {isSmartPlaylistName(pl.name) && (smartCoverIdsByPlaylist[pl.id]?.length ?? 0) > 0 ? (
                  <div className="playlist-cover-grid">
                    {Array.from({ length: 4 }, (_, i) => {
                      const id = smartCoverIdsByPlaylist[pl.id][i % smartCoverIdsByPlaylist[pl.id].length];
                      return id ? (
                        <PlaylistSmartCoverCell key={i} coverId={id} />
                      ) : (
                        <div key={i} className="playlist-cover-cell playlist-cover-cell--empty" />
                      );
                    })}
                  </div>
                ) : pl.coverArt ? (
                  <PlaylistCardMainCover coverArt={pl.coverArt} alt={pl.name} />
                ) : (
                  <div className="album-card-cover-placeholder playlist-card-icon">
                    <ListMusic size={48} strokeWidth={1.2} />
                  </div>
                )}
                {pendingSmart.some(p => p.id === pl.id || p.name === pl.name) && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 8,
                      left: 8,
                      width: 24,
                      height: 24,
                      borderRadius: 999,
                      background: 'rgba(0,0,0,0.45)',
                      border: '1px solid rgba(255,255,255,0.25)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'white',
                      zIndex: 8,
                      pointerEvents: 'none',
                    }}
                    data-tooltip={t('common.loading')}
                  >
                    <Clock3 size={13} />
                  </div>
                )}

                {/* Play overlay — same pattern as AlbumCard */}
                <div className="album-card-play-overlay">
                  <button
                    className="album-card-details-btn"
                    onClick={(e) => handlePlay(e, pl)}
                    disabled={playingId === pl.id}
                  >
                    {playingId === pl.id
                      ? <span className="spinner" style={{ width: 14, height: 14 }} />
                      : <Play size={15} fill="currentColor" />
                    }
                  </button>
                </div>

              </div>

              <div className="album-card-info">
                <div className="album-card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {isSmartPlaylistName(pl.name) && <Sparkles size={14} style={{ color: 'var(--text-muted)', flex: '0 0 auto' }} />}
                  <span>{displayPlaylistName(pl.name)}</span>
                </div>
                <div className="album-card-artist">
                  {t('playlists.songs', { n: filteredSongCountByPlaylist[pl.id] ?? pl.songCount })}
                  {(filteredDurationByPlaylist[pl.id] ?? pl.duration) > 0 && (
                    <> · {formatDuration(filteredDurationByPlaylist[pl.id] ?? pl.duration)}</>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
