import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Check, Clock3, ListMusic, Pencil, Play, Sparkles, Trash2 } from 'lucide-react';
import type { SubsonicPlaylist } from '../../api/subsonicTypes';
import { usePlayerStore } from '../../store/playerStore';
import {
  displayPlaylistName, isSmartPlaylistName, type PendingSmartPlaylist,
} from '../../utils/playlistsSmart';
import { formatHumanHoursMinutes } from '../../utils/formatHumanDuration';
import { PlaylistCardMainCover, PlaylistSmartCoverCell } from './PlaylistCoverImages';

interface Props {
  pl: SubsonicPlaylist;
  selectionMode: boolean;
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
  pl, selectionMode, selectedIds, selectedPlaylists,
  toggleSelect, isPlaylistDeletable,
  deleteConfirmId, setDeleteConfirmId,
  handleOpenSmartEditor, handleDelete, handlePlay, playingId,
  smartCoverIdsByPlaylist, pendingSmart,
  filteredSongCountByPlaylist, filteredDurationByPlaylist,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openContextMenu = usePlayerStore(s => s.openContextMenu);

  return (
    <div
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
            <> · {formatHumanHoursMinutes(filteredDurationByPlaylist[pl.id] ?? pl.duration)}</>
          )}
        </div>
      </div>
    </div>
  );
}
