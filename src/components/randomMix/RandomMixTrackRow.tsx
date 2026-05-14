import React from 'react';
import { useTranslation } from 'react-i18next';
import { AudioLines, ChevronRight, Heart, Play, Square } from 'lucide-react';
import type { SubsonicSong } from '../../api/subsonicTypes';
import type { Track } from '../../store/playerStoreTypes';
import { usePreviewStore } from '../../store/previewStore';
import { useDragDrop } from '../../contexts/DragDropContext';
import { formatRandomMixDuration } from '../../utils/componentHelpers/randomMixHelpers';

interface Props {
  song: SubsonicSong;
  idx: number;
  gridTemplateColumns: string;
  track: Track;
  queueSongs: Track[];
  isCurrentTrack: boolean;
  isPlaying: boolean;
  isContextActive: boolean;
  orbitActive: boolean;
  previewingId: string | null;
  previewAudioStarted: boolean;
  starredOverrides: Record<string, boolean>;
  isStarred: boolean;
  customGenreBlacklist: string[];
  addedArtist: string | null;
  addedGenre: string | null;
  showGenreCol: boolean;
  isGenreBlocked: boolean;
  onPlay: () => void;
  onQueueHint: () => void;
  onAddTrackToOrbit: (id: string) => void;
  onOpenContextMenu: (e: React.MouseEvent) => void;
  onToggleStar: (e: React.MouseEvent) => void;
  onBlacklistArtist: (artist: string) => void;
  onBlacklistGenre: (genre: string) => void;
}

export default function RandomMixTrackRow({
  song, idx, gridTemplateColumns, track, queueSongs,
  isCurrentTrack, isPlaying, isContextActive, orbitActive,
  previewingId, previewAudioStarted, starredOverrides, isStarred,
  customGenreBlacklist, addedArtist, addedGenre, showGenreCol, isGenreBlocked,
  onPlay, onQueueHint, onAddTrackToOrbit, onOpenContextMenu, onToggleStar,
  onBlacklistArtist, onBlacklistGenre,
}: Props) {
  const { t } = useTranslation();
  const psyDrag = useDragDrop();

  const artist = song.artist;
  const genre = song.genre;
  const isArtistBlocked = !!artist && customGenreBlacklist.some(bg => artist.toLowerCase().includes(bg.toLowerCase()));
  const isArtistJustAdded = addedArtist === artist;
  const isGenreJustAdded = addedGenre === genre;
  const starColor = isStarred
    ? 'var(--color-star-active, var(--accent))'
    : 'var(--color-star-inactive, var(--text-muted))';

  return (
    <div
      className={`track-row track-row-with-actions${isCurrentTrack ? ' active' : ''}${isContextActive ? ' context-active' : ''}`}
      style={{ gridTemplateColumns }}
      onClick={e => {
        if ((e.target as HTMLElement).closest('button, a, input')) return;
        if (orbitActive) { onQueueHint(); return; }
        onPlay();
      }}
      onDoubleClick={orbitActive ? e => {
        if ((e.target as HTMLElement).closest('button, a, input')) return;
        onAddTrackToOrbit(song.id);
      } : undefined}
      role="row"
      onContextMenu={onOpenContextMenu}
      onMouseDown={e => {
        if (e.button !== 0) return;
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY;
        const onMove = (me: MouseEvent) => {
          if (Math.abs(me.clientX - sx) > 5 || Math.abs(me.clientY - sy) > 5) {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            psyDrag.startDrag({ data: JSON.stringify({ type: 'song', track }), label: song.title }, me.clientX, me.clientY);
          }
        };
        const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }}
    >
      <div className={`track-num${isCurrentTrack ? ' track-num-active' : ''}`}>
        {isCurrentTrack && isPlaying ? (
          <span className="track-num-eq"><AudioLines className="eq-bars" size={14} /></span>
        ) : (
          <span className="track-num-number">{idx + 1}</span>
        )}
      </div>

      <div className="track-info track-info-suggestion">
        <button
          type="button"
          className="playlist-suggestion-play-btn"
          onClick={e => { e.stopPropagation(); if (orbitActive) { onQueueHint(); return; } onPlay(); }}
          data-tooltip={t('common.play')}
          aria-label={t('common.play')}
        >
          <Play size={10} fill="currentColor" strokeWidth={0} className="playlist-suggestion-play-icon" />
        </button>
        <button
          type="button"
          className={`playlist-suggestion-preview-btn${previewingId === song.id ? ' is-previewing' : ''}${previewingId === song.id && previewAudioStarted ? ' audio-started' : ''}`}
          onClick={e => {
            e.stopPropagation();
            usePreviewStore.getState().startPreview(
              { id: song.id, title: song.title, artist: song.artist, coverArt: song.coverArt, duration: song.duration },
              'randomMix',
            );
          }}
          data-tooltip={previewingId === song.id ? t('playlists.previewStop') : t('playlists.preview')}
          aria-label={previewingId === song.id ? t('playlists.previewStop') : t('playlists.preview')}
        >
          <svg className="playlist-suggestion-preview-ring" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-track" />
            <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-progress" />
          </svg>
          {previewingId === song.id
            ? <Square size={9} fill="currentColor" strokeWidth={0} className="playlist-suggestion-preview-icon" />
            : <ChevronRight size={14} className="playlist-suggestion-preview-icon playlist-suggestion-preview-icon-play" />}
        </button>
        <span className="track-title">{song.title}</span>
      </div>

      <div className="track-artist-cell">
        {artist ? (
          <button
            className={`rm-artist-btn${isArtistBlocked ? ' is-blocked' : isArtistJustAdded ? ' just-added' : ''}`}
            onClick={() => { if (!isArtistBlocked) onBlacklistArtist(artist); }}
            data-tooltip={isArtistBlocked ? t('randomMix.artistBlocked') : isArtistJustAdded ? t('randomMix.artistAddedToBlacklist') : t('randomMix.artistClickHint')}
          >{artist}</button>
        ) : <span className="track-artist">—</span>}
      </div>

      <div className="track-info">
        <span className="track-title" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{song.album ?? '—'}</span>
      </div>

      {showGenreCol && (
        <div>
          {genre ? (
            <button
              className={`rm-genre-chip${isGenreBlocked ? ' is-blocked' : isGenreJustAdded ? ' just-added' : ''}`}
              onClick={() => { if (!isGenreBlocked) onBlacklistGenre(genre); }}
              data-tooltip={isGenreBlocked ? t('randomMix.genreBlocked') : isGenreJustAdded ? t('randomMix.genreAddedToBlacklist') : t('randomMix.genreClickHint')}
            >{genre}</button>
          ) : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>}
        </div>
      )}

      <div className="track-star-cell">
        <button
          className="btn btn-ghost track-star-btn"
          onClick={onToggleStar}
          data-tooltip={isStarred ? t('randomMix.favoriteRemove') : t('randomMix.favoriteAdd')}
          style={{ color: starColor }}
        >
          <Heart size={14} fill={isStarred ? 'currentColor' : 'none'} />
        </button>
      </div>

      <div className="track-duration">{formatRandomMixDuration(song.duration)}</div>
    </div>
  );
}
