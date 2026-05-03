import React, { memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, ListPlus, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SubsonicSong, buildCoverArtUrl, coverArtCacheKey } from '../api/subsonic';
import { usePlayerStore, songToTrack } from '../store/playerStore';
import CachedImage from './CachedImage';
import { enqueueAndPlay } from '../utils/playSong';
import { useDragDrop } from '../contexts/DragDropContext';
import { useOrbitSongRowBehavior } from '../hooks/useOrbitSongRowBehavior';

interface SongCardProps {
  song: SubsonicSong;
}

function SongCard({ song }: SongCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const enqueue = usePlayerStore(s => s.enqueue);
  const coverUrl = song.coverArt ? buildCoverArtUrl(song.coverArt, 200) : '';
  const psyDrag = useDragDrop();
  const { orbitActive, addTrackToOrbit } = useOrbitSongRowBehavior();

  const handlePlay = () => {
    if (orbitActive) { addTrackToOrbit(song.id); return; }
    enqueueAndPlay(song);
  };

  const handleEnqueue = () => {
    if (orbitActive) { addTrackToOrbit(song.id); return; }
    enqueue([songToTrack(song)]);
  };

  const handleClick = handlePlay;

  const handleArtistClick = (e: React.MouseEvent) => {
    if (!song.artistId) return;
    e.stopPropagation();
    navigate(`/artist/${song.artistId}`);
  };

  return (
    <div
      className="song-card card"
      onClick={handleClick}
      role="button"
      tabIndex={0}
      aria-label={`${song.title} – ${song.artist}`}
      onKeyDown={e => e.key === 'Enter' && handleClick()}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, song, 'song');
      }}
      onMouseDown={e => {
        if (e.button !== 0) return;
        const sx = e.clientX, sy = e.clientY;
        const onMove = (me: MouseEvent) => {
          if (Math.abs(me.clientX - sx) > 5 || Math.abs(me.clientY - sy) > 5) {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            psyDrag.startDrag(
              { data: JSON.stringify({ type: 'song', id: song.id, name: song.title }), label: song.title, coverUrl: coverUrl || undefined },
              me.clientX, me.clientY,
            );
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
      <div className="song-card-cover">
        {coverUrl ? (
          <CachedImage
            src={coverUrl}
            cacheKey={coverArtCacheKey(song.coverArt!, 200)}
            alt={`${song.album} Cover`}
            loading="lazy"
          />
        ) : (
          <div className="song-card-cover-placeholder">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </div>
        )}
        <div className="song-card-play-overlay">
          <button
            className="song-card-action-btn"
            onClick={e => { e.stopPropagation(); handlePlay(); }}
            aria-label={t('tracks.playSong')}
            data-tooltip={t('tracks.playSong')}
            data-tooltip-pos="top"
          >
            <Play size={14} fill="currentColor" />
          </button>
          <button
            className="song-card-action-btn"
            onClick={e => { e.stopPropagation(); handleEnqueue(); }}
            aria-label={t('tracks.enqueueSong')}
            data-tooltip={t('tracks.enqueueSong')}
            data-tooltip-pos="top"
          >
            <ListPlus size={14} />
          </button>
        </div>
      </div>
      <div className="song-card-info">
        <p className="song-card-title truncate" title={song.title}>{song.title}</p>
        <p
          className={`song-card-artist truncate${song.artistId ? ' track-artist-link' : ''}`}
          style={{ cursor: song.artistId ? 'pointer' : 'default' }}
          onClick={handleArtistClick}
          title={song.artist}
        >{song.artist}</p>
        {(song.userRating ?? 0) > 0 && (
          <div className="song-card-rating" aria-label={`${song.userRating} stars`}>
            {Array.from({ length: 5 }, (_, i) => (
              <Star
                key={i}
                size={11}
                fill={i < (song.userRating ?? 0) ? 'currentColor' : 'none'}
                strokeWidth={1.5}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(SongCard);
