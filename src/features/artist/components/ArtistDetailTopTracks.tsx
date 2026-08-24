import React from 'react';
import { useTranslation } from 'react-i18next';
import { AudioLines, ChevronRight, Play, Square } from 'lucide-react';
import type { SubsonicAlbum, SubsonicSong } from '@/lib/api/subsonicTypes';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { previewInputFromSong, usePreviewStore } from '@/features/playback/store/previewStore';
import { useOrbitSongRowBehavior } from '@/features/orbit';
import { songToTrack } from '@/lib/media/songToTrack';
import { formatTrackTime } from '@/lib/format/formatDuration';
import ArtistTopTrackCover from '@/features/artist/components/ArtistTopTrackCover';
import { topSongAlbumForCover } from '@/features/artist/components/topSongAlbumForCover';

interface Props {
  topSongs: SubsonicSong[];
  loading?: boolean;
  albums: SubsonicAlbum[];
  playTopSongWithContinuation: (startIndex: number) => Promise<void>;
}

/**
 * The server's popularity ranking for an artist. Named and spaced by the tab
 * strip above it, so it renders the table alone.
 */
export default function ArtistDetailTopTracks({
  topSongs, loading = false, albums, playTopSongWithContinuation,
}: Props) {
  const { t } = useTranslation();
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const previewingId = usePreviewStore(s => s.previewingId);
  const previewAudioStarted = usePreviewStore(s => s.audioStarted);
  const { orbitActive, queueHint, addTrackToOrbit } = useOrbitSongRowBehavior();

  // The offline and local-index branches leave the ranking empty while the full
  // list still has tracks. Without this the tab would show a bare header row —
  // and it must not claim the artist has no tracks, because the neighbouring tab
  // may well be listing hundreds. Only the ranking is missing.
  if (!loading && topSongs.length === 0) {
    return (
      <div className="empty-state" style={{ padding: '2rem 0' }}>
        {t('artistDetail.topTracksEmpty')}
      </div>
    );
  }

  return (
  <div
    className="tracklist"
    data-preview-loc="artist"
    aria-busy={loading}
    style={{ padding: 0 }}
  >
    <div className="tracklist-header" style={{ gridTemplateColumns: '60px minmax(150px, 1fr) minmax(100px, 1fr) 65px' }}>
      <div style={{ textAlign: 'center' }}>#</div>
      <div>{t('artistDetail.trackTitle')}</div>
      <div>{t('artistDetail.trackAlbum')}</div>
      <div style={{ textAlign: 'right' }}>{t('artistDetail.trackDuration')}</div>
    </div>
      {loading && topSongs.length === 0 ? Array.from({ length: 5 }, (_, idx) => (
        <div
          key={idx}
          className="track-row artist-top-track-skeleton"
          style={{ gridTemplateColumns: '60px minmax(150px, 1fr) minmax(100px, 1fr) 65px' }}
          aria-hidden="true"
        >
          <div className="artist-top-track-skeleton-rank" />
          <div className="artist-top-track-skeleton-title">
            <div className="artist-top-track-skeleton-cover" />
            <div className="artist-top-track-skeleton-line artist-top-track-skeleton-line--title" />
          </div>
          <div className="artist-top-track-skeleton-line artist-top-track-skeleton-line--album" />
          <div className="artist-top-track-skeleton-line artist-top-track-skeleton-line--duration" />
        </div>
      )) : topSongs.map((song, idx) => {
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
                  addTrackToOrbit(song.id, song.serverId);
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
            onClick={e => { e.stopPropagation(); usePreviewStore.getState().startPreview(previewInputFromSong(song), 'artist'); }}
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
          {(() => {
            const albumForCover = topSongAlbumForCover(song, albums);
            return albumForCover ? <ArtistTopTrackCover album={albumForCover} /> : null;
          })()}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div className="track-title">{song.title}</div>
          </div>
        </div>
        <div className="track-album truncate" style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
          {song.album}
        </div>
        <div className="track-duration" style={{ textAlign: 'right' }}>
        {formatTrackTime(song.duration)}
         </div>
       </div>
       );
      })}
   </div>
  );
}
