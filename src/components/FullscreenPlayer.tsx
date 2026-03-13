import React, { useCallback, useEffect, useState, useRef, memo } from 'react';
import {
  Play, Pause, SkipBack, SkipForward,
  ChevronDown, Repeat, Repeat1, Square, Music
} from 'lucide-react';
import { usePlayerStore } from '../store/playerStore';
import { buildCoverArtUrl, coverArtCacheKey, getArtistInfo } from '../api/subsonic';
import CachedImage, { useCachedUrl } from './CachedImage';
import { useTranslation } from 'react-i18next';

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Crossfading blurred background ───────────────────────────────────────────
const FsBg = memo(function FsBg({ url }: { url: string }) {
  const [layers, setLayers] = useState<Array<{ url: string; id: number; visible: boolean }>>(() =>
    url ? [{ url, id: 0, visible: true }] : []
  );
  const counterRef = useRef(1);

  useEffect(() => {
    if (!url) return;
    const id = counterRef.current++;
    setLayers(prev => [...prev, { url, id, visible: false }]);
    const t1 = setTimeout(() => {
      setLayers(prev => prev.map(l => ({ ...l, visible: l.id === id })));
    }, 20);
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

// ─── Progress bar (isolated — re-renders every tick) ──────────────────────────
const FsProgress = memo(function FsProgress({ duration }: { duration: number }) {
  const progress    = usePlayerStore(s => s.progress);
  const currentTime = usePlayerStore(s => s.currentTime);
  const seek        = usePlayerStore(s => s.seek);

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => seek(parseFloat(e.target.value)),
    [seek]
  );

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

// ─── Play/Pause button (isolated — subscribes to isPlaying only) ──────────────
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

// ─── Main component ────────────────────────────────────────────────────────────
interface FullscreenPlayerProps {
  onClose: () => void;
}

export default function FullscreenPlayer({ onClose }: FullscreenPlayerProps) {
  const { t } = useTranslation();
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const repeatMode   = usePlayerStore(s => s.repeatMode);
  const next         = usePlayerStore(s => s.next);
  const previous     = usePlayerStore(s => s.previous);
  const stop         = usePlayerStore(s => s.stop);
  const toggleRepeat = usePlayerStore(s => s.toggleRepeat);

  const duration = currentTrack?.duration ?? 0;
  const coverUrl = currentTrack?.coverArt ? buildCoverArtUrl(currentTrack.coverArt, 800) : '';
  const coverKey = currentTrack?.coverArt ? coverArtCacheKey(currentTrack.coverArt, 800) : '';
  // useCachedUrl must be called unconditionally (hook rules)
  const resolvedCoverUrl = useCachedUrl(coverUrl, coverKey);

  // Fetch artist image for background — fall back to cover art if unavailable
  const [artistBgUrl, setArtistBgUrl] = useState<string>('');
  useEffect(() => {
    setArtistBgUrl('');
    const artistId = currentTrack?.artistId;
    if (!artistId) return;
    let cancelled = false;
    getArtistInfo(artistId).then(info => {
      if (!cancelled && info.largeImageUrl) setArtistBgUrl(info.largeImageUrl);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentTrack?.artistId]);

  const bgUrl = artistBgUrl || resolvedCoverUrl;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fs-player" role="dialog" aria-modal="true" aria-label={t('player.fullscreen')}>

      {/* Layer 1 — blurred artist image (falls back to cover art) */}
      <FsBg url={bgUrl} />
      <div className="fs-bg-overlay" aria-hidden="true" />

      {/* Layer 2 — drifting color orbs */}
      <div className="fs-orb fs-orb-1" aria-hidden="true" />
      <div className="fs-orb fs-orb-2" aria-hidden="true" />
      <div className="fs-orb fs-orb-3" aria-hidden="true" />

      {/* Close */}
      <button className="fs-close" onClick={onClose} aria-label={t('player.closeFullscreen')}>
        <ChevronDown size={28} />
      </button>

      {/* Center stage — everything vertically + horizontally centered */}
      <div className="fs-stage">

        <p className="fs-artist">{currentTrack?.artist ?? '—'}</p>

        <div className="fs-cover-wrap">
          {coverUrl ? (
            <CachedImage
              src={coverUrl}
              cacheKey={coverKey}
              alt={`${currentTrack?.album} Cover`}
              className="fs-cover"
            />
          ) : (
            <div className="fs-cover fs-cover-placeholder"><Music size={72} /></div>
          )}
        </div>

        <div className="fs-track-info">
          <h1 className="fs-title">{currentTrack?.title ?? '—'}</h1>
          <p className="fs-album">
            {currentTrack?.album ?? ''}
            {currentTrack?.year ? ` · ${currentTrack.year}` : ''}
          </p>
          {(currentTrack?.bitRate || currentTrack?.suffix) && (
            <span className="fs-codec">
              {[
                currentTrack.suffix?.toUpperCase(),
                currentTrack.bitRate ? `${currentTrack.bitRate} kbps` : ''
              ].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>

        <FsProgress duration={duration} />

        <div className="fs-controls">
          <button className="fs-btn fs-btn-sm" onClick={stop} aria-label="Stop">
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
            aria-label={t('player.repeat')}
          >
            {repeatMode === 'one' ? <Repeat1 size={14} /> : <Repeat size={14} />}
          </button>
        </div>

      </div>
    </div>
  );
}
