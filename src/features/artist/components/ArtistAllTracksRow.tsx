import React from 'react';
import { useTranslation } from 'react-i18next';
import { AudioLines, ChevronRight, Play, Square } from 'lucide-react';
import type { ColDef } from '@/lib/hooks/useTracklistColumns';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { codecLabel } from '@/lib/format/playlistDetailHelpers';
import { formatLastSeen } from '@/lib/format/userMgmtHelpers';
import { formatTrackTime } from '@/lib/format/formatDuration';
import i18n from '@/lib/i18n';
import { ResolvedArtistRefInline } from '@/ui/ResolvedArtistRefInline';
import { useAuthStore } from '@/store/authStore';
import { resolveTrackArtistRefs } from '@/features/playback';
import { OptionalBrowseTrackRowCoverThumb } from '@/cover/TrackRowCoverThumb';

export interface ArtistAllTracksRowCallbacks {
  activate: (song: SubsonicSong, index: number, e: React.MouseEvent) => void;
  dblOrbit: (song: SubsonicSong, e: React.MouseEvent) => void;
  context: (song: SubsonicSong, e: React.MouseEvent) => void;
  mouseDownRow: (song: SubsonicSong, e: React.MouseEvent) => void;
  play: (index: number) => void;
  startPreview: (song: SubsonicSong) => void;
  navArtist: (artistId: string, serverId?: string) => void;
  navAlbum: (albumId: string, serverId?: string) => void;
}

interface Props {
  song: SubsonicSong;
  index: number;
  visibleCols: ColDef[];
  gridStyle: React.CSSProperties;
  showBitrate: boolean;
  isActive: boolean;
  showEq: boolean;
  isPreviewing: boolean;
  previewStarted: boolean;
  orbitActive: boolean;
  cb: ArtistAllTracksRowCallbacks;
}

/**
 * One row of the artist's full track list. Cells mirror the other tracklists so a
 * column reads the same everywhere; the row carries no selection or server-writing
 * controls, which is what keeps it lighter than its album and favourites siblings.
 */
function ArtistAllTracksRow({
  song, index: i, visibleCols, gridStyle, showBitrate,
  isActive, showEq, isPreviewing, previewStarted, orbitActive, cb,
}: Props) {
  const { t } = useTranslation();
  // `song.serverId` is only stamped on owned/multi-server rows.
  const activeServerId = useAuthStore(s => s.activeServerId ?? '');

  return (
    <div
      className={`track-row track-row-va track-row-with-actions${isActive ? ' active' : ''}`}
      style={gridStyle}
      role="row"
      onClick={e => cb.activate(song, i, e)}
      onDoubleClick={orbitActive ? e => cb.dblOrbit(song, e) : undefined}
      onContextMenu={e => cb.context(song, e)}
      onMouseDown={e => cb.mouseDownRow(song, e)}
    >
      {visibleCols.map(colDef => {
        switch (colDef.key) {
          case 'num': return (
            <div key="num" className={`track-num${isActive ? ' track-num-active' : ''}`}>
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
              <OptionalBrowseTrackRowCoverThumb song={song} size="dense" />
              <span className="track-title">{song.title}</span>
            </div>
          );
          case 'album': return (
            <div key="album" className="track-artist-cell">
              <span
                className={`track-artist${song.albumId ? ' track-artist-link' : ''}`}
                style={{ cursor: song.albumId ? 'pointer' : 'default' }}
                onClick={e => { if (song.albumId) { e.stopPropagation(); cb.navAlbum(song.albumId, song.serverId); } }}
              >
                {song.album}
              </span>
            </div>
          );
          case 'artist': return (
            <div key="artist" className="track-artist-cell">
              <ResolvedArtistRefInline
                refs={resolveTrackArtistRefs(song)}
                serverId={song.serverId ?? activeServerId}
                fallbackName={song.artist}
                onGoArtist={id => cb.navArtist(id, song.serverId)}
                as="none"
                linkTag="span"
                linkClassName="track-artist track-artist-link"
                separatorClassName="track-artist-sep"
              />
            </div>
          );
          case 'duration': return (
            <div key="duration" className="track-duration">{formatTrackTime(song.duration)}</div>
          );
          case 'format': return (
            <div key="format" className="track-meta">
              {(song.suffix || (showBitrate && song.bitRate)) && (
                <span className="track-codec">{codecLabel(song, showBitrate)}</span>
              )}
            </div>
          );
          case 'genre': return (
            <div key="genre" className="track-genre">{song.genre ?? '—'}</div>
          );
          case 'year': return (
            <div key="year" className="track-duration">{song.year && song.year > 0 ? song.year : '—'}</div>
          );
          case 'playCount': return (
            <div key="playCount" className="track-duration">{song.playCount ?? '—'}</div>
          );
          case 'lastPlayed': return (
            <div key="lastPlayed" className="track-genre">
              {song.played ? formatLastSeen(song.played, i18n.language, '—') : '—'}
            </div>
          );
          case 'bpm': return (
            <div key="bpm" className="track-duration">{song.bpm && song.bpm > 0 ? song.bpm : '—'}</div>
          );
          default: return null;
        }
      })}
    </div>
  );
}

export default React.memo(ArtistAllTracksRow);
