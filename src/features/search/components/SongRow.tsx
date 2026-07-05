import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { songToTrack } from '@/lib/media/songToTrack';
import React, { memo } from 'react';
import { useNavigateToAlbum } from '@/features/album';
import { useNavigateToArtist } from '@/features/artist';
import { Play, ListPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { enqueueAndPlay } from '@/features/playback/utils/playback/playSong';
import { useDragDrop } from '@/lib/dnd/DragDropContext';
import { useOrbitSongRowBehavior } from '@/features/orbit';
import { formatTrackTime } from '@/lib/format/formatDuration';
import { resolveTrackArtistRefs } from '@/features/playback/utils/playback/trackArtistRefs';
import { tooltipAttrs } from '@/ui/tooltipAttrs';

interface Props {
  song: SubsonicSong;
  showBpm?: boolean;
}

function SongRow({ song, showBpm }: Props) {
  const navigateToAlbum = useNavigateToAlbum();
  const navigateToArtist = useNavigateToArtist();
  const { t } = useTranslation();
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

  const artistRefs = resolveTrackArtistRefs(song);

  const bpmTooltip =
    song.localBpmSource === 'analysis'
      ? t('search.bpmSourceAnalysis')
      : song.localBpmSource === 'tag'
        ? t('search.bpmSourceTag')
        : undefined;

  return (
    <div
      className={`song-list-row${isCurrent ? ' is-current' : ''}${showBpm ? ' song-list-row--with-bpm' : ''}`}
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
          {...tooltipAttrs(t('common.play'))}
        >
          <Play size={14} fill="currentColor" />
        </button>
        <button
          className="song-list-row-btn"
          onClick={(e) => { e.stopPropagation(); handleEnqueue(); }}
          {...tooltipAttrs(t('common.addToQueue'))}
        >
          <ListPlus size={14} />
        </button>
      </div>
      <div className="song-list-row-cell song-list-row-title truncate" title={song.title}>{song.title}</div>
      <div className="song-list-row-cell truncate" title={song.artist}>
        {artistRefs.map((a, i) => (
          <React.Fragment key={a.id ?? a.name ?? i}>
            {i > 0 && <span className="track-artist-sep">&nbsp;·&nbsp;</span>}
            <span
              className={a.id ? 'track-artist-link' : ''}
              style={{ cursor: a.id ? 'pointer' : 'default' }}
              onClick={(e) => { if (a.id) { e.stopPropagation(); navigateToArtist(a.id!); } }}
            >{a.name ?? song.artist}</span>
          </React.Fragment>
        ))}
      </div>
      <div className="song-list-row-cell truncate">
        {song.albumId ? (
          <span
            className="track-artist-link"
            style={{ cursor: 'pointer' }}
            onClick={(e) => { e.stopPropagation(); navigateToAlbum(song.albumId!); }}
            title={song.album}
          >{song.album}</span>
        ) : <span title={song.album}>{song.album}</span>}
      </div>
      <div className="song-list-row-cell song-list-row-genre truncate" title={song.genre ?? ''}>
        {song.genre ?? '—'}
      </div>
      {showBpm && (
        <div
          className="song-list-row-cell song-list-row-bpm"
          data-tooltip={bpmTooltip}
        >
          {song.bpm != null && song.bpm > 0 ? song.bpm : '—'}
        </div>
      )}
      <div className="song-list-row-cell song-list-row-duration">{formatTrackTime(song.duration, '–')}</div>
    </div>
  );
}

/** Column header with the same grid as <SongRow>. Optional — pages can render it above the list. */
export function SongListHeader({ showBpm }: { showBpm?: boolean } = {}) {
  const { t } = useTranslation();
  return (
    <div
      className={`song-list-row song-list-row--header${showBpm ? ' song-list-row--with-bpm' : ''}`}
      role="row"
    >
      <div className="song-list-row-cell song-list-row-actions" />
      <div className="song-list-row-cell">{t('albumDetail.trackTitle')}</div>
      <div className="song-list-row-cell">{t('albumDetail.trackArtist')}</div>
      <div className="song-list-row-cell">{t('albumDetail.trackAlbum')}</div>
      <div className="song-list-row-cell">{t('randomMix.trackGenre')}</div>
      {showBpm && (
        <div className="song-list-row-cell song-list-row-bpm">{t('albumDetail.trackBpm')}</div>
      )}
      <div className="song-list-row-cell song-list-row-duration">{t('albumDetail.trackDuration')}</div>
    </div>
  );
}

export default memo(SongRow);
