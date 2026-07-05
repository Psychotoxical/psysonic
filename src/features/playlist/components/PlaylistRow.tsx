import React from 'react';
import { useTranslation } from 'react-i18next';
import { AudioLines, ChevronRight, Heart, Play, Square, Trash2 } from 'lucide-react';
import type { ColDef } from '@/lib/hooks/useTracklistColumns';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { codecLabel } from '@/lib/format/playlistDetailHelpers';
import { formatLastSeen } from '@/lib/format/userMgmtHelpers';
import i18n from '@/lib/i18n';
import { formatTrackTime } from '@/lib/format/formatDuration';
import StarRating from '@/ui/StarRating';
import { PlaylistArtistCell } from '@/features/playlist/components/PlaylistArtistCell';

export interface PlaylistRowCallbacks {
  activate: (song: SubsonicSong, index: number, e: React.MouseEvent) => void;
  dblOrbit: (songId: string, e: React.MouseEvent) => void;
  context: (song: SubsonicSong, realIdx: number, e: React.MouseEvent) => void;
  mouseDownRow: (realIdx: number, e: React.MouseEvent) => void;
  mouseEnterRow: (index: number, e: React.MouseEvent) => void;
  toggleSelect: (songId: string, index: number, shift: boolean) => void;
  play: (index: number) => void;
  startPreview: (song: SubsonicSong) => void;
  toggleStar: (song: SubsonicSong, e: React.MouseEvent) => void;
  rate: (songId: string, rating: number) => void;
  remove: (realIdx: number) => void;
  navArtist: (artistId: string) => void;
  navAlbum: (albumId: string) => void;
}

interface Props {
  song: SubsonicSong;
  index: number;
  realIdx: number;
  visibleCols: ColDef[];
  gridStyle: React.CSSProperties;
  showBitrate: boolean;
  isActive: boolean;
  showEq: boolean;
  isContextActive: boolean;
  isSelected: boolean;
  inSelectMode: boolean;
  isStarred: boolean;
  ratingValue: number;
  isPreviewing: boolean;
  previewStarted: boolean;
  orbitActive: boolean;
  cb: PlaylistRowCallbacks;
}

function PlaylistRow({
  song, index: i, realIdx, visibleCols, gridStyle, showBitrate,
  isActive, showEq, isContextActive, isSelected, inSelectMode,
  isStarred, ratingValue, isPreviewing, previewStarted, orbitActive, cb,
}: Props) {
  const { t } = useTranslation();

  return (
    <div
      data-track-idx={realIdx}
      className={`track-row track-row-va track-row-with-actions tracklist-playlist${isActive ? ' active' : ''}${isContextActive ? ' context-active' : ''}${isSelected ? ' bulk-selected' : ''}`}
      style={gridStyle}
      onMouseEnter={e => cb.mouseEnterRow(i, e)}
      onMouseDown={e => cb.mouseDownRow(realIdx, e)}
      onClick={e => cb.activate(song, i, e)}
      onDoubleClick={orbitActive ? e => cb.dblOrbit(song.id, e) : undefined}
      onContextMenu={e => cb.context(song, realIdx, e)}
    >
      {visibleCols.map(colDef => {
        switch (colDef.key) {
          case 'num': return (
            <div key="num" className={`track-num${isActive ? ' track-num-active' : ''}`}>
              <span className={`bulk-check${isSelected ? ' checked' : ''}${inSelectMode ? ' bulk-check-visible' : ''}`} onClick={e => { e.stopPropagation(); cb.toggleSelect(song.id, i, e.shiftKey); }} />
              {showEq ? (
                <span className="track-num-eq"><AudioLines className="eq-bars" size={14} /></span>
              ) : (
                <span className="track-num-number">{i + 1}</span>
              )}
            </div>
          );
          case 'title': return (
            <div key="title" className="track-info track-info-suggestion">
              <button
                type="button"
                className="playlist-suggestion-play-btn"
                onClick={e => { e.stopPropagation(); cb.play(i); }}
                data-tooltip={t('common.play')}
                aria-label={t('common.play')}
              >
                <Play size={10} fill="currentColor" strokeWidth={0} className="playlist-suggestion-play-icon" />
              </button>
              <button
                type="button"
                className={`playlist-suggestion-preview-btn${isPreviewing ? ' is-previewing' : ''}${isPreviewing && previewStarted ? ' audio-started' : ''}`}
                onClick={e => { e.stopPropagation(); cb.startPreview(song); }}
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
          case 'artist': return <PlaylistArtistCell key="artist" song={song} />;
          case 'album': return (
            <div key="album" className="track-artist-cell">
              <span className={`track-artist${song.albumId ? ' track-artist-link' : ''}`} style={{ cursor: song.albumId ? 'pointer' : 'default' }} onClick={e => { if (song.albumId) { e.stopPropagation(); cb.navAlbum(song.albumId); } }}>{song.album}</span>
            </div>
          );
          case 'favorite': return (
            <div key="favorite" className="track-star-cell">
              <button className="btn btn-ghost track-star-btn" onClick={e => cb.toggleStar(song, e)} style={{ color: isStarred ? 'var(--color-star-active, var(--accent))' : 'var(--color-star-inactive, var(--text-muted))' }}>
                <Heart size={14} fill={isStarred ? 'currentColor' : 'none'} />
              </button>
            </div>
          );
          case 'rating': return <StarRating key="rating" value={ratingValue} onChange={r => cb.rate(song.id, r)} />;
          case 'duration': return <div key="duration" className="track-duration">{formatTrackTime(song.duration ?? 0)}</div>;
          case 'format': return (
            <div key="format" className="track-meta">
              {(song.suffix || (showBitrate && song.bitRate)) && <span className="track-codec">{codecLabel(song, showBitrate)}</span>}
            </div>
          );
          case 'genre': return (
            <div key="genre" className="track-genre">{song.genre ?? '—'}</div>
          );
          case 'playCount': return (
            <div key="playCount" className="track-duration">{song.playCount ?? '—'}</div>
          );
          case 'lastPlayed': return (
            <div key="lastPlayed" className="track-genre">{song.played ? formatLastSeen(song.played, i18n.language, '—') : '—'}</div>
          );
          case 'bpm': return (
            <div key="bpm" className="track-duration">{song.bpm && song.bpm > 0 ? song.bpm : '—'}</div>
          );
          case 'delete': return (
            <div key="delete" className="playlist-row-delete-cell">
              <button className="playlist-row-delete-btn" onClick={e => { e.stopPropagation(); cb.remove(realIdx); }} data-tooltip={t('playlists.removeSong')} data-tooltip-pos="left">
                <Trash2 size={13} />
              </button>
            </div>
          );
          default: return null;
        }
      })}
    </div>
  );
}

export default React.memo(PlaylistRow);
