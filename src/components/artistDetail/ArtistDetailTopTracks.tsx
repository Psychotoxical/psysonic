import React, { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { AudioLines, ChevronRight, Play, Square } from 'lucide-react';
import type { SubsonicSong } from '../../api/subsonicTypes';
import { usePlayerStore } from '../../store/playerStore';
import { usePreviewStore } from '../../store/previewStore';
import { useOrbitSongRowBehavior } from '../../hooks/useOrbitSongRowBehavior';
import { songToTrack } from '../../utils/songToTrack';
import { formatDuration } from '../../utils/artistDetailHelpers';
import ArtistSuggestionTrackCover from './ArtistSuggestionTrackCover';

interface Props {
  topSongs: SubsonicSong[];
  marginTop: string;
  playTopSongWithContinuation: (startIndex: number) => Promise<void>;
}

export default function ArtistDetailTopTracks({ topSongs, marginTop, playTopSongWithContinuation }: Props) {
  const { t } = useTranslation();
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const previewingId = usePreviewStore(s => s.previewingId);
  const previewAudioStarted = usePreviewStore(s => s.audioStarted);
  const { orbitActive, queueHint, addTrackToOrbit } = useOrbitSongRowBehavior();

  return (
    <Fragment>
      <h2 className="section-title" style={{ marginTop, marginBottom: '1rem' }}>
        {t('artistDetail.topTracks')}
      </h2>
  <div className="tracklist" data-preview-loc="artist" style={{ padding: 0, marginBottom: '2rem' }}>
    <div className="tracklist-header" style={{ gridTemplateColumns: '60px minmax(150px, 1fr) minmax(100px, 1fr) 65px' }}>
      <div style={{ textAlign: 'center' }}>#</div>
      <div>{t('artistDetail.trackTitle')}</div>
      <div>{t('artistDetail.trackAlbum')}</div>
      <div style={{ textAlign: 'right' }}>{t('artistDetail.trackDuration')}</div>
    </div>
     {topSongs.map((song, idx) => {
           const track = songToTrack(song);
           return (
             <div
               key={`${song.id}-${idx}`}
               className="track-row track-row-with-actions"
               style={{ gridTemplateColumns: '60px minmax(150px, 1fr) minmax(100px, 1fr) 65px' }}
               onClick={e => {
                 if ((e.target as HTMLElement).closest('button, a, input')) return;
                 if (orbitActive) { queueHint(); return; }
                 playTopSongWithContinuation(idx);
               }}
               onDoubleClick={orbitActive ? e => {
                 if ((e.target as HTMLElement).closest('button, a, input')) return;
                 addTrackToOrbit(song.id);
               } : undefined}
               onContextMenu={(e) => {
                 e.preventDefault();
                 openContextMenu(e.clientX, e.clientY, track, 'song');
               }}
             >
        <div className={`track-num${currentTrack?.id === song.id ? ' track-num-active' : ''}`}>
          {currentTrack?.id === song.id && isPlaying ? (
            <span className="track-num-eq"><AudioLines className="eq-bars" size={14} /></span>
          ) : (
            <span className="track-num-number">{idx + 1}</span>
          )}
        </div>
        <div className="track-info track-info-suggestion" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            type="button"
            className="playlist-suggestion-play-btn"
            onClick={e => { e.stopPropagation(); if (orbitActive) { queueHint(); return; } playTopSongWithContinuation(idx); }}
            data-tooltip={t('common.play')}
            aria-label={t('common.play')}
          >
            <Play size={10} fill="currentColor" strokeWidth={0} className="playlist-suggestion-play-icon" />
          </button>
          <button
            type="button"
            className={`playlist-suggestion-preview-btn${previewingId === song.id ? ' is-previewing' : ''}${previewingId === song.id && previewAudioStarted ? ' audio-started' : ''}`}
            onClick={e => { e.stopPropagation(); usePreviewStore.getState().startPreview({ id: song.id, title: song.title, artist: song.artist, coverArt: song.coverArt, duration: song.duration }, 'artist'); }}
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
          {song.coverArt && (
            <ArtistSuggestionTrackCover coverArt={song.coverArt} album={song.album} />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div className="track-title">{song.title}</div>
          </div>
        </div>
        <div className="track-album truncate" style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
          {song.album}
        </div>
        <div className="track-duration" style={{ textAlign: 'right' }}>
        {formatDuration(song.duration)}
         </div>
       </div>
       );
     })}
   </div>
    </Fragment>
  );
}
