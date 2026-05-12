import { songToTrack } from '../utils/songToTrack';
import React, { memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, ListPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SubsonicSong } from '../api/subsonic';
import { usePlayerStore } from '../store/playerStore';
import { enqueueAndPlay } from '../utils/playSong';
import { useDragDrop } from '../contexts/DragDropContext';
import { useOrbitSongRowBehavior } from '../hooks/useOrbitSongRowBehavior';

function fmtDuration(s: number): string {
  if (!s || !isFinite(s)) return '–';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

interface Props {
  song: SubsonicSong;
}

function SongRow({ song }: Props) {
  const navigate = useNavigate();
  const enqueue = usePlayerStore(s => s.enqueue);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const isCurrent = usePlayerStore(s => s.currentTrack?.id === song.id);
  const psyDrag = useDragDrop();
  const { orbitActive, addTrackToOrbit } = useOrbitSongRowBehavior();

  // In an orbit session both buttons collapse into the orbit-suggest / host-enqueue
  // path so we don't ship a queue replacement to every guest.
  const handlePlay = () => {
    if (orbitActive) { addTrackToOrbit(song.id); return; }
    enqueueAndPlay(song);
  };

  const handleEnqueue = () => {
    if (orbitActive) { addTrackToOrbit(song.id); return; }
    enqueue([songToTrack(song)]);
  };

  return (
    <div
      className={`song-list-row${isCurrent ? ' is-current' : ''}`}
      onDoubleClick={handlePlay}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, song, 'song');
      }}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        const sx = e.clientX, sy = e.clientY;
        const track = songToTrack(song);
        const onMove = (me: MouseEvent) => {
          if (Math.abs(me.clientX - sx) > 5 || Math.abs(me.clientY - sy) > 5) {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            psyDrag.startDrag(
              { data: JSON.stringify({ type: 'song', track }), label: song.title },
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
      <div className="song-list-row-cell song-list-row-actions">
        <button
          className="song-list-row-btn song-list-row-btn--play"
          onClick={(e) => { e.stopPropagation(); handlePlay(); }}
          aria-label="Play"
        >
          <Play size={14} fill="currentColor" />
        </button>
        <button
          className="song-list-row-btn"
          onClick={(e) => { e.stopPropagation(); handleEnqueue(); }}
          aria-label="Enqueue"
        >
          <ListPlus size={14} />
        </button>
      </div>
      <div className="song-list-row-cell song-list-row-title truncate" title={song.title}>{song.title}</div>
      <div className="song-list-row-cell truncate">
        <span
          className={song.artistId ? 'track-artist-link' : ''}
          style={{ cursor: song.artistId ? 'pointer' : 'default' }}
          onClick={(e) => { if (song.artistId) { e.stopPropagation(); navigate(`/artist/${song.artistId}`); } }}
          title={song.artist}
        >{song.artist}</span>
      </div>
      <div className="song-list-row-cell truncate">
        {song.albumId ? (
          <span
            className="track-artist-link"
            style={{ cursor: 'pointer' }}
            onClick={(e) => { e.stopPropagation(); navigate(`/album/${song.albumId}`); }}
            title={song.album}
          >{song.album}</span>
        ) : <span title={song.album}>{song.album}</span>}
      </div>
      <div className="song-list-row-cell song-list-row-genre truncate" title={song.genre ?? ''}>
        {song.genre ?? '—'}
      </div>
      <div className="song-list-row-cell song-list-row-duration">{fmtDuration(song.duration)}</div>
    </div>
  );
}

/** Column header with the same grid as <SongRow>. Optional — pages can render it above the list. */
export function SongListHeader() {
  const { t } = useTranslation();
  return (
    <div className="song-list-row song-list-row--header" role="row">
      <div className="song-list-row-cell song-list-row-actions" />
      <div className="song-list-row-cell">{t('albumDetail.trackTitle')}</div>
      <div className="song-list-row-cell">{t('albumDetail.trackArtist')}</div>
      <div className="song-list-row-cell">{t('albumDetail.trackAlbum')}</div>
      <div className="song-list-row-cell">{t('randomMix.trackGenre')}</div>
      <div className="song-list-row-cell song-list-row-duration">{t('albumDetail.trackDuration')}</div>
    </div>
  );
}

export default memo(SongRow);
