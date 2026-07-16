import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Check, Clock3, ListMusic, Pencil, Play, Sparkles, Trash2 } from 'lucide-react';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import {
  displayPlaylistName, isSmartPlaylistName, type PendingSmartPlaylist,
} from '@/features/playlist/utils/playlistsSmart';
import { formatHumanHoursMinutes } from '@/lib/format/formatHumanDuration';
import { useDragSource } from '@/lib/dnd/DragDropContext';
import { PlaylistCardMainCover, PlaylistSmartCoverCell } from '@/features/playlist/components/PlaylistCoverImages';
import { libraryEntityKey } from '@/lib/library/libraryEntityKey';

interface Props {
  pl: SubsonicPlaylist;
  selectionMode: boolean;
  /** Enables dragging the card onto a folder drop target (folder view only). */
  draggable?: boolean;
  selectedIds: Set<string>;
  selectedPlaylists: SubsonicPlaylist[];
  toggleSelect: (id: string, opts?: { shiftKey?: boolean }) => void;
  isPlaylistDeletable: (pl: SubsonicPlaylist) => boolean;
  deleteConfirmId: string | null;
  setDeleteConfirmId: React.Dispatch<React.SetStateAction<string | null>>;
  handleOpenSmartEditor: (pl: SubsonicPlaylist) => Promise<void>;
  handleDelete: (e: React.MouseEvent, pl: SubsonicPlaylist) => void;
  handlePlay: (e: React.MouseEvent, pl: SubsonicPlaylist) => void;
  playingId: string | null;
  smartCoverIdsByPlaylist: Record<string, string[]>;
  pendingSmart: PendingSmartPlaylist[];
  filteredSongCountByPlaylist: Record<string, number>;
  filteredDurationByPlaylist: Record<string, number>;
}

export default function PlaylistCard({
  pl, selectionMode, draggable, selectedIds, selectedPlaylists,
  toggleSelect, isPlaylistDeletable,
  deleteConfirmId, setDeleteConfirmId,
  handleOpenSmartEditor, handleDelete, handlePlay, playingId,
  smartCoverIdsByPlaylist, pendingSmart,
  filteredSongCountByPlaylist, filteredDurationByPlaylist,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const dragHandlers = useDragSource(() => ({
    data: JSON.stringify({ type: 'playlist', id: pl.id, serverId: pl.serverId }),
    label: displayPlaylistName(pl.name),
  }));
  const dragEnabled = Boolean(draggable) && !selectionMode;
  const playlistKey = libraryEntityKey(pl);

  return (
    <div
      className={`album-card${selectionMode && selectedIds.has(playlistKey) ? ' album-card--selected' : ''}${dragEnabled ? ' album-card--draggable' : ''}`}
      {...(dragEnabled ? dragHandlers : {})}
      onClick={(e) => {
        if (selectionMode) {
          toggleSelect(playlistKey, { shiftKey: e.shiftKey });
        } else {
          navigate(`/playlists/${pl.id}${pl.serverId ? `?server=${encodeURIComponent(pl.serverId)}` : ''}`);
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
      onMouseLeave={() => { if (deleteConfirmId === playlistKey) setDeleteConfirmId(null); }}
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
                navigate(`/playlists/${pl.id}${pl.serverId ? `?server=${encodeURIComponent(pl.serverId)}` : ''}`, { state: { openEditMeta: true } });
              }}
              data-tooltip={t('playlists.editMeta')}
            >
              <Pencil size={13} />
            </button>
          )}
          {isPlaylistDeletable(pl) && (
            <button
              className={`playlist-card-action playlist-card-action--delete${deleteConfirmId === playlistKey ? ' playlist-card-action--delete-confirm' : ''}`}
              onClick={(e) => handleDelete(e, pl)}
              data-tooltip={deleteConfirmId === playlistKey ? t('playlists.confirmDelete') : t('common.delete')}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      )}
      {selectionMode && (
        <div className={`album-card-select-check${selectedIds.has(playlistKey) ? ' album-card-select-check--on' : ''}`}>
          {selectedIds.has(playlistKey) && <Check size={14} strokeWidth={3} />}
        </div>
      )}
      {/* Cover area — server collage or fallback icon */}
      <div className="album-card-cover">
        {isSmartPlaylistName(pl.name) && (smartCoverIdsByPlaylist[playlistKey]?.length ?? 0) > 0 ? (
          <div className="playlist-cover-grid">
            {Array.from({ length: 4 }, (_, i) => {
              const id = smartCoverIdsByPlaylist[playlistKey][i % smartCoverIdsByPlaylist[playlistKey].length];
              return id ? (
                <PlaylistSmartCoverCell key={i} coverId={id} serverId={pl.serverId} />
              ) : (
                <div key={i} className="playlist-cover-cell playlist-cover-cell--empty" />
              );
            })}
          </div>
        ) : pl.coverArt ? (
          <PlaylistCardMainCover coverArt={pl.coverArt} alt={pl.name} serverId={pl.serverId} />
        ) : (
          <div className="album-card-cover-placeholder playlist-card-icon">
            <ListMusic size={48} strokeWidth={1.2} />
          </div>
        )}
        {pendingSmart.some(p => p.serverId === pl.serverId && (p.id === pl.id || p.name === pl.name)) && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              width: 24,
              height: 24,
              borderRadius: 'var(--radius-sm)',
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
            disabled={playingId === playlistKey}
          >
            {playingId === playlistKey
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
          {t('playlists.songs', { count: filteredSongCountByPlaylist[playlistKey] ?? pl.songCount })}
          {(filteredDurationByPlaylist[playlistKey] ?? pl.duration) > 0 && (
            <> · {formatHumanHoursMinutes(filteredDurationByPlaylist[playlistKey] ?? pl.duration)}</>
          )}
        </div>
      </div>
    </div>
  );
}
