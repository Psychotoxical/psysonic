import React from 'react';
import { AudioLines, ChevronRight, Heart, Play, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { ColDef } from '../../utils/useTracklistColumns';
import type { SubsonicSong } from '../../api/subsonicTypes';
import type { Track } from '../../store/playerStoreTypes';
import { songToTrack } from '../../utils/songToTrack';
import { useSelectionStore } from '../../store/selectionStore';
import { useThemeStore } from '../../store/themeStore';
import { usePreviewStore } from '../../store/previewStore';
import StarRating from '../StarRating';
import { codecLabel, formatDuration, type ColKey } from '../../utils/albumTrackListHelpers';

type ContextMenuFn = (
  x: number,
  y: number,
  track: Track,
  type: 'song' | 'album' | 'artist' | 'queue-item' | 'album-song',
) => void;

interface TrackRowProps {
  song: SubsonicSong;
  globalIdx: number;
  visibleCols: readonly ColDef[];
  gridStyle: React.CSSProperties;
  currentTrackId: string | null;
  isPlaying: boolean;
  ratingValue: number;
  isStarred: boolean;
  inSelectMode: boolean;
  isContextMenuSong: boolean;
  onPlaySong: (song: SubsonicSong) => void;
  onDoubleClickSong?: (song: SubsonicSong) => void;
  onRate: (songId: string, rating: number) => void;
  onToggleSongStar: (song: SubsonicSong, e: React.MouseEvent) => void;
  onContextMenu: ContextMenuFn;
  onToggleSelect: (id: string, globalIdx: number, shift: boolean) => void;
  onDragStart: (song: SubsonicSong, me: MouseEvent) => void;
  setContextMenuSongId: (id: string | null) => void;
}

/**
 * Memoised tracklist row. Subscribes to its own selection + preview state
 * via primitive selectors so only this row re-renders when the user
 * toggles selection or starts/stops a preview.
 */
export const TrackRow = React.memo(function TrackRow({
  song,
  globalIdx,
  visibleCols,
  gridStyle,
  currentTrackId,
  isPlaying,
  ratingValue,
  isStarred,
  inSelectMode,
  isContextMenuSong,
  onPlaySong,
  onDoubleClickSong,
  onRate,
  onToggleSongStar,
  onContextMenu,
  onToggleSelect,
  onDragStart,
  setContextMenuSongId,
}: TrackRowProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const showBitrate = useThemeStore(s => s.showBitrate);
  const isSelected = useSelectionStore(s => s.selectedIds.has(song.id));
  const isActive = currentTrackId === song.id;
  const isPreviewing = usePreviewStore(s => s.previewingId === song.id);
  const isPreviewAudioStarted = usePreviewStore(s => s.previewingId === song.id && s.audioStarted);

  const renderCell = (colDef: ColDef) => {
    const key = colDef.key as ColKey;
    switch (key) {
      case 'num':
        return (
          <div
            key="num"
            className={`track-num${isActive ? ' track-num-active' : ''}`}
          >
            <span
              className={`bulk-check${isSelected ? ' checked' : ''}${inSelectMode ? ' bulk-check-visible' : ''}`}
              onClick={e => { e.stopPropagation(); onToggleSelect(song.id, globalIdx, e.shiftKey); }}
            />
            {isActive && isPlaying ? (
              <span className="track-num-eq">
                <AudioLines className="eq-bars" size={14} />
              </span>
            ) : (
              <span className="track-num-number">{song.track ?? '—'}</span>
            )}
          </div>
        );
      case 'title':
        return (
          <div key="title" className="track-info track-info-suggestion">
            <button
              type="button"
              className="playlist-suggestion-play-btn"
              onClick={e => { e.stopPropagation(); onPlaySong(song); }}
              onDoubleClick={onDoubleClickSong ? e => { e.stopPropagation(); onDoubleClickSong(song); } : undefined}
              data-tooltip={t('common.play')}
              aria-label={t('common.play')}
            >
              <Play size={10} fill="currentColor" strokeWidth={0} className="playlist-suggestion-play-icon" />
            </button>
            <button
              type="button"
              className={`playlist-suggestion-preview-btn${isPreviewing ? ' is-previewing' : ''}${isPreviewAudioStarted ? ' audio-started' : ''}`}
              onClick={e => {
                e.stopPropagation();
                usePreviewStore.getState().startPreview({ id: song.id, title: song.title, artist: song.artist, coverArt: song.coverArt, duration: song.duration }, 'albums');
              }}
              data-tooltip={isPreviewing ? t('playlists.previewStop') : t('playlists.preview')}
              aria-label={isPreviewing ? t('playlists.previewStop') : t('playlists.preview')}
            >
              <svg className="playlist-suggestion-preview-ring" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-track" />
                <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-progress" />
              </svg>
              {isPreviewing
                ? <Square size={9} fill="currentColor" strokeWidth={0} className="playlist-suggestion-preview-icon" />
                : <ChevronRight size={14} className="playlist-suggestion-preview-icon playlist-suggestion-preview-icon-play" />}
            </button>
            <span className="track-title">{song.title}</span>
          </div>
        );
      case 'artist': {
        const artistRefs = song.artists && song.artists.length > 0
          ? song.artists
          : [{ id: song.artistId, name: song.artist }];
        return (
          <div key="artist" className="track-artist-cell">
            {artistRefs.map((a, i) => (
              <React.Fragment key={a.id ?? a.name ?? i}>
                {i > 0 && <span className="track-artist-sep">&nbsp;·&nbsp;</span>}
                <span
                  className={`track-artist${a.id ? ' track-artist-link' : ''}`}
                  style={{ cursor: a.id ? 'pointer' : 'default' }}
                  onClick={e => { if (a.id) { e.stopPropagation(); navigate(`/artist/${a.id}`); } }}
                >
                  {a.name ?? song.artist}
                </span>
              </React.Fragment>
            ))}
          </div>
        );
      }
      case 'favorite':
        return (
          <div key="favorite" className="track-star-cell">
            <button
              className={`btn btn-ghost track-star-btn${isStarred ? ' is-starred' : ''}`}
              onClick={e => onToggleSongStar(song, e)}
              data-tooltip={isStarred ? t('albumDetail.favoriteRemove') : t('albumDetail.favoriteAdd')}
            >
              <Heart size={14} fill={isStarred ? 'currentColor' : 'none'} />
            </button>
          </div>
        );
      case 'rating':
        return (
          <StarRating
            key="rating"
            value={ratingValue}
            onChange={r => onRate(song.id, r)}
          />
        );
      case 'duration':
        return (
          <div key="duration" className="track-duration">
            {formatDuration(song.duration)}
          </div>
        );
      case 'format':
        return (
          <div key="format" className="track-meta">
            {(song.suffix || (showBitrate && song.bitRate)) && (
              <span className="track-codec">{codecLabel(song, showBitrate)}</span>
            )}
          </div>
        );
      case 'genre':
        return (
          <div key="genre" className="track-genre">
            {song.genre ?? '—'}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div
      className={`track-row track-row-va track-row-with-actions${isActive ? ' active' : ''}${isContextMenuSong ? ' context-active' : ''}${isSelected ? ' bulk-selected' : ''}`}
      style={gridStyle}
      onClick={e => {
        if ((e.target as HTMLElement).closest('button, a, input')) return;
        if (e.ctrlKey || e.metaKey) {
          onToggleSelect(song.id, globalIdx, false);
        } else if (inSelectMode) {
          onToggleSelect(song.id, globalIdx, e.shiftKey);
        } else {
          onPlaySong(song);
        }
      }}
      onDoubleClick={onDoubleClickSong ? e => {
        if ((e.target as HTMLElement).closest('button, a, input')) return;
        if (e.ctrlKey || e.metaKey || inSelectMode) return;
        onDoubleClickSong(song);
      } : undefined}
      onContextMenu={e => {
        e.preventDefault();
        setContextMenuSongId(song.id);
        onContextMenu(e.clientX, e.clientY, songToTrack(song), 'album-song');
      }}
      role="row"
      onMouseDown={e => {
        if (e.button !== 0) return;
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY;
        const onMove = (me: MouseEvent) => {
          if (Math.abs(me.clientX - sx) > 5 || Math.abs(me.clientY - sy) > 5) {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            onDragStart(song, me);
          }
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }}
    >
      {visibleCols.map(colDef => renderCell(colDef))}
    </div>
  );
});
