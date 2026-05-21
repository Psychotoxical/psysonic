import React from 'react';
import { useTranslation } from 'react-i18next';
import { AudioLines, ChevronRight, Play, Square, X } from 'lucide-react';
import type { ColDef } from '../../utils/useTracklistColumns';
import type { SubsonicSong } from '../../api/subsonicTypes';
import { codecLabel } from '../../utils/componentHelpers/playlistDetailHelpers';
import { formatLastSeen } from '../../utils/componentHelpers/userMgmtHelpers';
import i18n from '../../i18n';
import { formatTrackTime } from '../../utils/format/formatDuration';
import StarRating from '../StarRating';

export interface FavoriteSongRowCallbacks {
  activate: (song: SubsonicSong, index: number, e: React.MouseEvent) => void;
  dblOrbit: (songId: string, e: React.MouseEvent) => void;
  context: (song: SubsonicSong, e: React.MouseEvent) => void;
  mouseDownRow: (song: SubsonicSong, e: React.MouseEvent) => void;
  toggleSelect: (songId: string, index: number, shift: boolean) => void;
  play: (index: number) => void;
  startPreview: (song: SubsonicSong) => void;
  rate: (songId: string, rating: number) => void;
  remove: (songId: string) => void;
  navArtist: (artistId: string) => void;
  navAlbum: (albumId: string) => void;
}

interface Props {
  song: SubsonicSong;
  index: number;
  visibleCols: ColDef[];
  gridStyle: React.CSSProperties;
  showBitrate: boolean;
  isActive: boolean;
  showEq: boolean;
  isSelected: boolean;
  inSelectMode: boolean;
  ratingValue: number;
  isPreviewing: boolean;
  previewStarted: boolean;
  orbitActive: boolean;
  cb: FavoriteSongRowCallbacks;
}

function FavoriteSongRow({
  song, index: i, visibleCols, gridStyle, showBitrate,
  isActive, showEq, isSelected, inSelectMode,
  ratingValue, isPreviewing, previewStarted, orbitActive, cb,
}: Props) {
  const { t } = useTranslation();

  return (
    <div
      className={`track-row track-row-va track-row-with-actions${isActive ? ' active' : ''}${isSelected ? ' bulk-selected' : ''}`}
      style={gridStyle}
      role="row"
      onClick={e => cb.activate(song, i, e)}
      onDoubleClick={orbitActive ? e => cb.dblOrbit(song.id, e) : undefined}
      onContextMenu={e => cb.context(song, e)}
      onMouseDown={e => cb.mouseDownRow(song, e)}
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
          case 'artist': return (
            <div key="artist" className="track-artist-cell">
              <span className={`track-artist${song.artistId ? ' track-artist-link' : ''}`} style={{ cursor: song.artistId ? 'pointer' : 'default' }} onClick={e => { if (song.artistId) { e.stopPropagation(); cb.navArtist(song.artistId); } }}>{song.artist}</span>
            </div>
          );
          case 'album': return (
            <div key="album" className="track-artist-cell">
              <span className={`track-artist${song.albumId ? ' track-artist-link' : ''}`} style={{ cursor: song.albumId ? 'pointer' : 'default' }} onClick={e => { if (song.albumId) { e.stopPropagation(); cb.navAlbum(song.albumId); } }}>{song.album}</span>
            </div>
          );
          case 'genre': return (
            <div key="genre" className="track-genre">{song.genre ?? '—'}</div>
          );
          case 'format': return (
            <div key="format" className="track-meta">
              {(song.suffix || (showBitrate && song.bitRate)) && <span className="track-codec">{codecLabel(song, showBitrate)}</span>}
            </div>
          );
          case 'rating': return <StarRating key="rating" value={ratingValue} onChange={r => cb.rate(song.id, r)} />;
          case 'duration': return <div key="duration" className="track-duration">{formatTrackTime(song.duration)}</div>;
          case 'playCount': return (
            <div key="playCount" className="track-duration">{song.playCount ?? '—'}</div>
          );
          case 'lastPlayed': return (
            <div key="lastPlayed" className="track-genre">{song.played ? formatLastSeen(song.played, i18n.language, '—') : '—'}</div>
          );
          case 'bpm': return (
            <div key="bpm" className="track-duration">{song.bpm && song.bpm > 0 ? song.bpm : '—'}</div>
          );
          case 'remove': return (
            <div key="remove" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <button className="btn-icon fav-remove-btn" data-tooltip={t('favorites.removeSong')} onClick={e => { e.stopPropagation(); cb.remove(song.id); }} aria-label={t('favorites.removeSong')}>
                <X size={14} />
              </button>
            </div>
          );
          default: return null;
        }
      })}
    </div>
  );
}

export default React.memo(FavoriteSongRow);
