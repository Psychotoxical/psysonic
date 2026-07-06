import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SkipBack, SkipForward, Play, Pause, Repeat, Repeat1,
  Volume2, VolumeX, ListMusic, MessageSquare, Shrink,
} from 'lucide-react';
import {
  usePlayerStore, getPlaybackProgressSnapshot, subscribePlaybackProgress,
} from '@/features/playback';
import { useThemeStore } from '@/store/themeStore';
import { useArtistFanart } from '@/cover/useArtistFanart';
import { backdropFromConfig } from '@/cover/artistBackdrop';
import { useAlbumCoverRef, useArtistCoverRef } from '@/cover/useLibraryCoverRef';
import { usePlaybackCoverArt } from '@/cover/usePlaybackCoverArt';
import { useCachedUrl } from '@/ui/CachedImage';
import { formatTrackTime } from '@/lib/format/formatDuration';
import { useFsDynamicAccent } from '@/features/fullscreenPlayer/hooks/useFsDynamicAccent';
import { useFsIdleFade } from '@/features/fullscreenPlayer/hooks/useFsIdleFade';
import { FsLyricsApple } from './FsLyricsApple';
import { FsQueueModal } from './FsQueueModal';

/** Elapsed / −remaining readout (e.g. `1:35 / -2:42`), imperative — no re-render per tick. */
const PrismTime = memo(function PrismTime({ duration }: { duration: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const paint = (currentTime: number) => {
      if (!ref.current) return;
      const remaining = duration > 0 ? Math.max(0, duration - currentTime) : 0;
      ref.current.textContent = `${formatTrackTime(currentTime)} / -${formatTrackTime(remaining)}`;
    };
    paint(getPlaybackProgressSnapshot().currentTime);
    return subscribePlaybackProgress(s => paint(s.currentTime));
  }, [duration]);
  return <span className="fsp2-time" ref={ref} />;
});

/** The now-playing pill's integrated progress line — imperative width + click/drag seek. */
const PrismProgress = memo(function PrismProgress({ duration }: { duration: number }) {
  const seek = usePlayerStore(s => s.seek);
  const playedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const draggingRef = useRef(false);
  const pendingRef = useRef<number | null>(null);

  useEffect(() => {
    const paint = (progress: number) => {
      if (playedRef.current) playedRef.current.style.width = `${progress * 100}%`;
      if (inputRef.current) inputRef.current.value = String(progress);
    };
    paint(getPlaybackProgressSnapshot().progress);
    return subscribePlaybackProgress(s => { if (!draggingRef.current) paint(s.progress); });
  }, []);

  const preview = useCallback((p: number) => {
    const v = Math.max(0, Math.min(1, p));
    pendingRef.current = v;
    if (playedRef.current) playedRef.current.style.width = `${v * 100}%`;
  }, []);
  const commit = useCallback(() => {
    draggingRef.current = false;
    if (pendingRef.current !== null) { seek(pendingRef.current); pendingRef.current = null; }
  }, [seek]);

  return (
    <div className="fsp2-progress">
      <div className="fsp2-progress-played" ref={playedRef} />
      <input
        ref={inputRef}
        type="range" min={0} max={1} step={0.001} defaultValue={0}
        onChange={e => preview(parseFloat(e.target.value))}
        onMouseDown={() => { draggingRef.current = true; }}
        onMouseUp={commit}
        onKeyDown={() => { draggingRef.current = true; }}
        onKeyUp={commit}
        onBlur={commit}
        aria-label="Seek"
        aria-valuetext={duration > 0 ? undefined : ''}
      />
    </div>
  );
});

/** Compact volume — icon toggles mute, hover reveals the slider. */
const PrismVolume = memo(function PrismVolume() {
  const { t } = useTranslation();
  const volume = usePlayerStore(s => s.volume);
  const setVolume = usePlayerStore(s => s.setVolume);
  const prevRef = useRef(volume || 1);
  const muted = volume <= 0;
  return (
    <div className="fsp2-volume">
      <button
        className="fsp2-btn"
        aria-label={t('player.volume')}
        onClick={() => {
          if (muted) { setVolume(prevRef.current || 1); }
          else { prevRef.current = volume; setVolume(0); }
        }}
      >
        {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
      </button>
      <input
        className="fsp2-volume-slider"
        type="range" min={0} max={1} step={0.01}
        value={volume}
        onChange={e => setVolume(parseFloat(e.target.value))}
        aria-label={t('player.volume')}
      />
    </div>
  );
});

export default function FullscreenPlayerPrism({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();

  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying    = usePlayerStore(s => s.isPlaying);
  const repeatMode   = usePlayerStore(s => s.repeatMode);
  const togglePlay   = usePlayerStore(s => s.togglePlay);
  const next         = usePlayerStore(s => s.next);
  const previous     = usePlayerStore(s => s.previous);
  const toggleRepeat = usePlayerStore(s => s.toggleRepeat);

  // Full-bleed backdrop — same resolution the Minimal/Immersive players use.
  const fsBackdropCfg = useThemeStore(s => s.backdrops.fullscreenPlayer);
  const fanart = useArtistFanart(currentTrack?.artistId, {
    artistName: currentTrack?.artist,
    albumTitle: currentTrack?.album,
  });
  const artistCoverRef =
    useArtistCoverRef(currentTrack?.artistId, undefined, undefined, { libraryResolve: false }) ?? undefined;
  const artistImage = usePlaybackCoverArt(artistCoverRef, 2000, { fullRes: true });
  const artistImgUrl = useCachedUrl(artistImage.src, artistImage.cacheKey, true);
  const bgUrl = fsBackdropCfg.enabled
    ? backdropFromConfig(fsBackdropCfg.sources, { fanart, navidrome: artistImgUrl }).url
    : '';

  // Cover-derived accent (album-keyed so it stays stable within an album).
  const albumRef =
    useAlbumCoverRef(currentTrack?.albumId, undefined, undefined, { libraryResolve: false }) ?? undefined;
  const cover = usePlaybackCoverArt(albumRef, 300);
  const dynamicAccent = useFsDynamicAccent(cover.src, cover.cacheKey);

  const [lyricsOpen, setLyricsOpen] = useState(true);
  const [queueOpen, setQueueOpen] = useState(false);
  const { isIdle, handleMouseMove } = useFsIdleFade(onClose);

  const duration = currentTrack?.duration ?? 0;
  const repeatIcon =
    repeatMode === 'one' ? <Repeat1 size={18} /> : <Repeat size={18} />;

  return (
    <div
      className="fsp2-player"
      role="dialog"
      aria-modal="true"
      aria-label={t('player.fullscreen')}
      data-idle={isIdle}
      onMouseMove={handleMouseMove}
      style={dynamicAccent ? ({ '--dynamic-fs-accent': dynamicAccent } as React.CSSProperties) : undefined}
    >
      {bgUrl && <div className="fsp2-bg" style={{ backgroundImage: `url("${bgUrl}")` }} aria-hidden="true" />}
      <div className="fsp2-bg-tint" aria-hidden="true" />

      {lyricsOpen && (
        <div className="fsp2-lyrics-panel">
          <FsLyricsApple currentTrack={currentTrack} />
        </div>
      )}

      <div className="fsp2-bar">
        {/* Transport + time */}
        <div className="fsp2-bar-left">
          <button className="fsp2-btn" onClick={previous} aria-label={t('player.prev')}><SkipBack size={18} /></button>
          <button className="fsp2-btn fsp2-btn-play" onClick={togglePlay} aria-label={isPlaying ? t('player.pause') : t('player.play')}>
            {isPlaying ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button className="fsp2-btn" onClick={() => next()} aria-label={t('player.next')}><SkipForward size={18} /></button>
          <button
            className={`fsp2-btn${repeatMode !== 'off' ? ' fsp2-btn-active' : ''}`}
            onClick={toggleRepeat}
            aria-label={t('player.repeat')}
          >
            {repeatIcon}
          </button>
          <PrismTime duration={duration} />
        </div>

        {/* Now-playing pill with integrated progress */}
        <div className="fsp2-pill">
          <div className="fsp2-pill-info">
            <span className="fsp2-pill-title">{currentTrack?.title ?? '—'}</span>
            <span className="fsp2-pill-sub">
              {[currentTrack?.album, currentTrack?.artist].filter(Boolean).join(' · ')}
            </span>
          </div>
          <PrismProgress duration={duration} />
        </div>

        {/* Utilities */}
        <div className="fsp2-bar-right">
          <PrismVolume />
          <button
            className={`fsp2-btn${queueOpen ? ' fsp2-btn-active' : ''}`}
            onClick={() => setQueueOpen(o => !o)}
            aria-label={t('queue.title')}
          >
            <ListMusic size={18} />
          </button>
          <button
            className={`fsp2-btn${lyricsOpen ? ' fsp2-btn-active' : ''}`}
            onClick={() => setLyricsOpen(o => !o)}
            aria-label={t('player.fsLyricsToggle')}
          >
            <MessageSquare size={18} />
          </button>
          <button className="fsp2-btn" onClick={onClose} aria-label={t('player.closeFullscreen')}>
            <Shrink size={18} />
          </button>
        </div>
      </div>

      {queueOpen && <FsQueueModal onClose={() => setQueueOpen(false)} />}
    </div>
  );
}
