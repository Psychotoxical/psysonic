import React, { useCallback, useEffect, useState, useRef, memo } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
  ChevronDown, Repeat, Repeat1, Square, Music
} from 'lucide-react';
import { usePlayerStore } from '../store/playerStore';
import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonic';
import CachedImage, { useCachedUrl } from './CachedImage';
import { useTranslation } from 'react-i18next';

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Crossfading blurred background — two stacked divs for true crossfade ───
const FsBg = memo(function FsBg({ url }: { url: string }) {
  // Each layer: {url, id, visible}
  const [layers, setLayers] = useState<Array<{ url: string; id: number; visible: boolean }>>(() =>
    url ? [{ url, id: 0, visible: true }] : []
  );
  const counterRef = useRef(1);

  useEffect(() => {
    if (!url) return;
    const id = counterRef.current++;
    // Add the new layer (opacity 0)
    setLayers(prev => [...prev, { url, id, visible: false }]);
    // One frame later: make new layer visible (0→1) and old ones invisible (1→0)
    const t1 = setTimeout(() => {
      setLayers(prev =>
        prev.map(l => ({ ...l, visible: l.id === id }))
      );
    }, 20);
    // After transition: clean up old layers
    const t2 = setTimeout(() => {
      setLayers(prev => prev.filter(l => l.id === id));
    }, 800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {layers.map(layer => (
        <div
          key={layer.id}
          className="fs-bg"
          style={{ backgroundImage: `url(${layer.url})`, opacity: layer.visible ? 1 : 0 }}
          aria-hidden="true"
        />
      ))}
    </>
  );
});

// ─── Isolated progress sub-component (re-renders every tick, nothing else does) ───
const FsProgress = memo(function FsProgress({ duration }: { duration: number }) {
  const progress    = usePlayerStore(s => s.progress);
  const currentTime = usePlayerStore(s => s.currentTime);
  const seek        = usePlayerStore(s => s.seek);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => seek(parseFloat(e.target.value)), [seek]);

  return (
    <div className="fs-progress-wrap">
      <span className="fs-time">{formatTime(currentTime)}</span>
      <div className="fs-progress-bar">
        <input
          type="range" min={0} max={1} step={0.001}
          value={progress}
          onChange={handleSeek}
          style={{ '--pct': `${progress * 100}%` } as React.CSSProperties}
          aria-label="progress"
        />
      </div>
      <span className="fs-time">{formatTime(duration)}</span>
    </div>
  );
});



// ─── Isolated play/pause button (subscribes to isPlaying only) ───
const FsPlayBtn = memo(function FsPlayBtn() {
  const { t } = useTranslation();
  const isPlaying  = usePlayerStore(s => s.isPlaying);
  const togglePlay = usePlayerStore(s => s.togglePlay);
  return (
    <button className="fs-btn fs-btn-play" onClick={togglePlay} aria-label={isPlaying ? t('player.pause') : t('player.play')}>
      {isPlaying ? <Pause size={25} /> : <Play size={25} fill="currentColor" />}
    </button>
  );
});

interface FullscreenPlayerProps {
  onClose: () => void;
}

export default function FullscreenPlayer({ onClose }: FullscreenPlayerProps) {
  const { t } = useTranslation();
  // Static/slow-changing state only — does NOT subscribe to progress or currentTime
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const repeatMode   = usePlayerStore(s => s.repeatMode);
  const queue        = usePlayerStore(s => s.queue);
  const queueIndex   = usePlayerStore(s => s.queueIndex);
  const next         = usePlayerStore(s => s.next);
  const previous     = usePlayerStore(s => s.previous);
  const stop         = usePlayerStore(s => s.stop);
  const toggleRepeat = usePlayerStore(s => s.toggleRepeat);
  const playTrack    = usePlayerStore(s => s.playTrack);

  const duration    = currentTrack?.duration ?? 0;
  const coverUrl    = currentTrack?.coverArt ? buildCoverArtUrl(currentTrack.coverArt, 800) : '';
  const coverKey    = currentTrack?.coverArt ? coverArtCacheKey(currentTrack.coverArt, 800) : '';
  const resolvedCoverUrl = useCachedUrl(coverUrl, coverKey);
  const upcoming    = queue.slice(queueIndex + 1, queueIndex + 15);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fs-player" role="dialog" aria-modal="true" aria-label={t('player.fullscreen')}>
      {/* Crossfading blurred background */}
      <FsBg url={resolvedCoverUrl} />
      <div className="fs-bg-overlay" aria-hidden="true" />

      {/* Close button */}
      <button className="fs-close" onClick={onClose} aria-label={t('player.closeFullscreen')} data-tooltip={t('player.closeTooltip')} data-tooltip-pos="bottom">
        <ChevronDown size={28} />
      </button>

      {/* Two-column layout: left = cover + info + controls, right = playlist */}
      <div className="fs-layout">

        {/* Left column */}
        <div className="fs-left">
          <div className="fs-cover-wrap">
            {coverUrl ? (
              <CachedImage src={coverUrl} cacheKey={coverKey} alt={`${currentTrack?.album} Cover`} className="fs-cover" />
            ) : (
              <div className="fs-cover fs-cover-placeholder"><Music size={72} /></div>
            )}
          </div>

          <div className="fs-track-info">
            <h1 className="fs-title">{currentTrack?.title ?? '—'}</h1>
            <p className="fs-artist">{currentTrack?.artist ?? '—'}</p>
            <p className="fs-album">{currentTrack?.album ?? '—'}{currentTrack?.year ? ` · ${currentTrack.year}` : ''}</p>
            {(currentTrack?.bitRate || currentTrack?.suffix) && (
              <span className="fs-codec">
                {[currentTrack.suffix?.toUpperCase(), currentTrack.bitRate ? `${currentTrack.bitRate} kbps` : ''].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>

          <FsProgress duration={duration} />

          <div className="fs-controls">
            <button className="fs-btn fs-btn-sm" onClick={stop} data-tooltip="Stop">
              <Square size={14} fill="currentColor" />
            </button>
            <button className="fs-btn" onClick={previous} aria-label={t('player.prev')}>
              <SkipBack size={20} />
            </button>
            <FsPlayBtn />
            <button className="fs-btn" onClick={next} aria-label={t('player.next')}>
              <SkipForward size={20} />
            </button>
            <button
              className={`fs-btn fs-btn-sm ${repeatMode !== 'off' ? 'active' : ''}`}
              onClick={toggleRepeat}
              data-tooltip={`${t('player.repeat')}: ${repeatMode === 'off' ? t('player.repeatOff') : repeatMode === 'all' ? t('player.repeatAll') : t('player.repeatOne')}`}
            >
              {repeatMode === 'one' ? <Repeat1 size={14} /> : <Repeat size={14} />}
            </button>
          </div>
        </div>

        {/* Right column: upcoming tracks */}
        {upcoming.length > 0 && (
          <div className="fs-right">
            <h2 className="fs-upcoming-title">{t('queue.nextTracks')}</h2>
            <div className="fs-upcoming-list">
              {upcoming.map((track, i) => (
                <button
                  key={`${track.id}-${queueIndex + 1 + i}`}
                  className="fs-upcoming-item"
                  onClick={() => playTrack(track, queue)}
                >
                  {track.coverArt ? (
                    <CachedImage src={buildCoverArtUrl(track.coverArt, 80)} cacheKey={coverArtCacheKey(track.coverArt, 80)} alt="" className="fs-upcoming-art" />
                  ) : (
                    <div className="fs-upcoming-art fs-upcoming-placeholder"><Music size={14} /></div>
                  )}
                  <div className="fs-upcoming-info">
                    <span className="fs-upcoming-name">{track.title}</span>
                    <span className="fs-upcoming-artist">{track.artist}</span>
                  </div>
                  <span className="fs-upcoming-dur">{formatTime(track.duration)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
