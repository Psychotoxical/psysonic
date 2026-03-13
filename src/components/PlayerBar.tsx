import React, { useCallback, useMemo } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Music, List, Square, Repeat, Repeat1, Maximize2
} from 'lucide-react';
import { usePlayerStore } from '../store/playerStore';
import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonic';
import CachedImage from './CachedImage';
import { useTranslation } from 'react-i18next';

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function PlayerBar() {
  const { t } = useTranslation();
  const { currentTrack, isPlaying, progress, currentTime, volume, togglePlay, next, previous, seek, setVolume, isQueueVisible, toggleQueue, stop, toggleRepeat, repeatMode, toggleFullscreen } = usePlayerStore();

  const duration = currentTrack?.duration ?? 0;
  const coverSrc = useMemo(() => currentTrack?.coverArt ? buildCoverArtUrl(currentTrack.coverArt, 128) : '', [currentTrack?.coverArt]);
  const coverKey = currentTrack?.coverArt ? coverArtCacheKey(currentTrack.coverArt, 128) : '';

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    seek(parseFloat(e.target.value));
  }, [seek]);

  const handleVolume = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setVolume(parseFloat(e.target.value));
  }, [setVolume]);

  const progressStyle = {
    background: `linear-gradient(to right, var(--ctp-mauve) ${progress * 100}%, var(--ctp-surface2) ${progress * 100}%)`,
  };

  const volumeStyle = {
    background: `linear-gradient(to right, var(--ctp-mauve) ${volume * 100}%, var(--ctp-surface2) ${volume * 100}%)`,
  };

  return (
    <footer className="player-bar" role="region" aria-label={t('player.regionLabel')}>
      {/* Track Info */}
      <div className="player-track-info">
        <div
          className={`player-album-art-wrap ${currentTrack ? 'clickable' : ''}`}
          onClick={() => currentTrack && toggleFullscreen()}
          data-tooltip={currentTrack ? t('player.openFullscreen') : undefined}
        >
          {currentTrack?.coverArt ? (
            <CachedImage
              className="player-album-art"
              src={coverSrc}
              cacheKey={coverKey}
              alt={`${currentTrack.album} Cover`}
            />
          ) : (
            <div className="player-album-art-placeholder">
              <Music size={22} />
            </div>
          )}
          {currentTrack && (
            <div className="player-art-expand-hint" aria-hidden="true">
              <Maximize2 size={16} />
            </div>
          )}
        </div>
        <div className="player-track-meta">
          <div className="player-track-name" data-tooltip={currentTrack?.title ?? ''}>
            {currentTrack?.title ?? t('player.noTitle')}
          </div>
          <div className="player-track-artist" data-tooltip={currentTrack?.artist ?? ''}>
            {currentTrack?.artist ?? '—'}
          </div>
        </div>
      </div>

      {/* Controls + Progress */}
      <div className="player-controls">
        <div className="player-buttons">
          <button className="player-btn" onClick={stop} aria-label={t('player.stop')} data-tooltip={t('player.stop')}>
            <Square size={16} fill="currentColor" />
          </button>
          
          <button className="player-btn" onClick={previous} aria-label={t('player.prev')} data-tooltip={t('player.prev')}>
            <SkipBack size={20} />
          </button>

          <button
            className="player-btn player-btn-primary"
            onClick={togglePlay}
            aria-label={isPlaying ? t('player.pause') : t('player.play')}
            data-tooltip={isPlaying ? t('player.pause') : t('player.play')}
          >
            {isPlaying ? <Pause size={22} /> : <Play size={22} fill="currentColor" />}
          </button>

          <button className="player-btn" onClick={next} aria-label={t('player.next')} data-tooltip={t('player.next')}>
            <SkipForward size={20} />
          </button>

          <button 
            className="player-btn" 
            onClick={toggleRepeat} 
            aria-label={t('player.repeat')} 
            data-tooltip={`${t('player.repeat')}: ${repeatMode === 'off' ? t('player.repeatOff') : repeatMode === 'all' ? t('player.repeatAll') : t('player.repeatOne')}`}
            style={{ color: repeatMode !== 'off' ? 'var(--accent)' : 'inherit' }}
          >
            {repeatMode === 'one' ? <Repeat1 size={18} /> : <Repeat size={18} />}
          </button>
        </div>

        <div className="player-progress">
          <span className="player-time">{formatTime(currentTime)}</span>
          <div className="player-progress-bar">
            <input
              type="range"
              id="player-seek"
              min={0}
              max={1}
              step={0.001}
              value={progress}
              onChange={handleSeek}
              style={progressStyle}
              aria-label={t('player.progress')}
            />
          </div>
          <span className="player-time">{formatTime(duration)}</span>
        </div>
      </div>

      {/* Volume + Connection */}
      <div className="player-right">
        <div className="volume-control" aria-label={t('player.volume')}>
          {volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
          <input
            type="range"
            id="player-volume"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={handleVolume}
            style={volumeStyle}
            aria-label={t('player.volume')}
          />
        </div>


        <button 
          className="player-btn" 
          onClick={toggleQueue} 
          aria-label={t('player.toggleQueue')} 
          data-tooltip={t('player.toggleQueue')}
          style={{ marginLeft: 'var(--space-3)', color: isQueueVisible ? 'var(--accent)' : 'var(--text-secondary)' }}
        >
          <List size={18} />
        </button>
      </div>
    </footer>
  );
}
