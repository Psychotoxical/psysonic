import React, { memo, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SkipBack, SkipForward, Play, Pause, Repeat, Repeat1,
  Volume2, VolumeX, ListMusic, MessageSquare, Shrink,
} from 'lucide-react';
import { usePlayerStore, useVolumeToggle, type PlaybackProgressSnapshot } from '@/features/playback';
import { useAlbumCoverRef } from '@/cover/useLibraryCoverRef';
import { usePlaybackCoverArt } from '@/cover/usePlaybackCoverArt';
import { useFsArtistBackdrop } from '@/features/fullscreenPlayer/hooks/useFsArtistBackdrop';
import { useImperativeSeek } from '@/features/fullscreenPlayer/hooks/useImperativeSeek';
import { useFsDynamicAccent } from '@/features/fullscreenPlayer/hooks/useFsDynamicAccent';
import { useFsIdleFade } from '@/features/fullscreenPlayer/hooks/useFsIdleFade';
import { FsTimeReadout } from './FsTimeReadout';
import { FsLyricsApple } from './FsLyricsApple';
import { FsQueueModal } from './FsQueueModal';

/** The now-playing pill's integrated progress line — imperative width + scrub seek. */
const PrismProgress = memo(function PrismProgress() {
  const playedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const paint = useCallback((s: PlaybackProgressSnapshot) => {
    if (playedRef.current) playedRef.current.style.width = `${s.progress * 100}%`;
    if (inputRef.current) inputRef.current.value = String(s.progress);
  }, []);
  const previewPaint = useCallback((p: number) => {
    if (playedRef.current) playedRef.current.style.width = `${p * 100}%`;
  }, []);
  const seekHandlers = useImperativeSeek({ paint, previewPaint });

  return (
    <div className="fsp2-progress">
      <div className="fsp2-progress-played" ref={playedRef} />
      <input
        ref={inputRef}
        type="range" min={0} max={1} step={0.001} defaultValue={0}
        aria-label="Seek"
        {...seekHandlers}
      />
    </div>
  );
});

/** Compact volume — icon toggles mute, hover reveals the slider. */
const PrismVolume = memo(function PrismVolume() {
  const { t } = useTranslation();
  const { volume, setVolume, muted, toggleMute } = useVolumeToggle();
  return (
    <div className="fsp2-volume">
      <button
        className="fsp2-btn"
        aria-label={muted ? t('player.unmute') : t('player.mute')}
        onClick={toggleMute}
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

  // Full-bleed backdrop — the same shared resolution all three FS players use.
  const bgUrl = useFsArtistBackdrop(currentTrack);

  // Cover-derived accent (album-keyed so it stays stable within an album).
  const albumRef =
    useAlbumCoverRef(currentTrack?.albumId, undefined, undefined, { libraryResolve: false }) ?? undefined;
  const cover = usePlaybackCoverArt(albumRef, 300);
  const dynamicAccent = useFsDynamicAccent(currentTrack?.directCoverArtUrl ?? cover.src, cover.cacheKey);

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
          <FsTimeReadout duration={duration} remaining className="fsp2-time" />
        </div>

        {/* Now-playing pill with integrated progress */}
        <div className="fsp2-pill">
          <div className="fsp2-pill-info">
            <span className="fsp2-pill-title">{currentTrack?.title ?? '—'}</span>
            <span className="fsp2-pill-sub">
              {[currentTrack?.album, currentTrack?.artist].filter(Boolean).join(' · ')}
            </span>
          </div>
          <PrismProgress />
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
