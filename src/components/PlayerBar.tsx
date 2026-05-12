import { star, unstar, setRating } from '../api/subsonicStarRating';
import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { getPlaybackProgressSnapshot, subscribePlaybackProgress } from '../store/playbackProgress';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Music,
  Square, Repeat, Repeat1, Maximize2, SlidersVertical, X, Heart, Cast,
  PictureInPicture2, ArrowLeftRight, Moon, Sunrise, Ellipsis,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { usePlayerStore } from '../store/playerStore';
import { useShallow } from 'zustand/react/shallow';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import CachedImage from './CachedImage';
import WaveformSeek from './WaveformSeek';
import Equalizer from './Equalizer';
import StarRating from './StarRating';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useLyricsStore } from '../store/lyricsStore';
import MarqueeText from './MarqueeText';
import LastfmIcon from './LastfmIcon';
import { useRadioMetadata } from '../hooks/useRadioMetadata';
import { usePlaybackDelayPress } from '../hooks/usePlaybackDelayPress';
import PlaybackDelayModal from './PlaybackDelayModal';
import PlaybackScheduleBadge from './PlaybackScheduleBadge';
import { usePlaybackScheduleRemaining } from '../utils/playbackScheduleFormat';
import { usePreviewStore } from '../store/previewStore';
import { usePerfProbeFlags } from '../utils/perfFlags';

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Renders the playback clock without ever causing PlayerBar to re-render.
// Updates the DOM directly via an imperative store subscription.
const PlaybackTime = memo(function PlaybackTime({ className }: { className?: string }) {
  const spanRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (spanRef.current) {
      spanRef.current.textContent = formatTime(getPlaybackProgressSnapshot().currentTime);
    }
    return subscribePlaybackProgress(state => {
      if (spanRef.current) spanRef.current.textContent = formatTime(state.currentTime);
    });
  }, []);
  return <span className={className} ref={spanRef} />;
});

// Renders the remaining time (duration - currentTime) without causing PlayerBar to re-render.
const RemainingTime = memo(function RemainingTime({ duration, className }: { duration: number; className?: string }) {
  const spanRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const updateRemaining = () => {
      if (spanRef.current) {
        const remaining = Math.max(0, duration - getPlaybackProgressSnapshot().currentTime);
        spanRef.current.textContent = `-${formatTime(remaining)}`;
      }
    };
    updateRemaining();
    return subscribePlaybackProgress(updateRemaining);
  }, [duration]);
  return <span className={className} ref={spanRef} />;
});

export default function PlayerBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [eqOpen, setEqOpen] = useState(false);
  const [showVolPct, setShowVolPct] = useState(false);
  const [localShowRemaining, setLocalShowRemaining] = useState(() => useThemeStore.getState().showRemainingTime);
  const premuteVolumeRef = useRef(1);
  const showLyrics   = useLyricsStore(s => s.showLyrics);
  const activeTab    = useLyricsStore(s => s.activeTab);
  // currentTime is intentionally excluded — PlaybackTime handles it via direct DOM update.
  const {
    currentTrack, currentRadio, isPlaying, volume,
    togglePlay, next, previous, setVolume,
    stop, toggleRepeat, repeatMode, toggleFullscreen,
    lastfmLoved, toggleLastfmLove,
    isQueueVisible, toggleQueue,
    starredOverrides, setStarredOverride,
    userRatingOverrides, setUserRatingOverride,
    openContextMenu,
  } = usePlayerStore(useShallow(s => ({
    currentTrack: s.currentTrack,
    currentRadio: s.currentRadio,
    isPlaying: s.isPlaying,
    volume: s.volume,
    togglePlay: s.togglePlay,
    next: s.next,
    previous: s.previous,
    setVolume: s.setVolume,
    stop: s.stop,
    toggleRepeat: s.toggleRepeat,
    repeatMode: s.repeatMode,
    toggleFullscreen: s.toggleFullscreen,
    lastfmLoved: s.lastfmLoved,
    toggleLastfmLove: s.toggleLastfmLove,
    isQueueVisible: s.isQueueVisible,
    toggleQueue: s.toggleQueue,
    starredOverrides: s.starredOverrides,
    setStarredOverride: s.setStarredOverride,
    userRatingOverrides: s.userRatingOverrides,
    setUserRatingOverride: s.setUserRatingOverride,
    openContextMenu: s.openContextMenu,
  })));
  const { lastfmSessionKey } = useAuthStore();
  const floatingPlayerBar = useThemeStore(s => s.floatingPlayerBar);
  const [floatingStyle, setFloatingStyle] = useState<React.CSSProperties>({});
  const playerBarRef = useRef<HTMLElement>(null);
  const [utilityOverflow, setUtilityOverflow] = useState(false);
  const [utilityMenuOpen, setUtilityMenuOpen] = useState(false);
  const [utilityMenuMode, setUtilityMenuMode] = useState<'full' | 'volume'>('full');
  const utilityMenuRef = useRef<HTMLDivElement>(null);
  const utilityBtnRef = useRef<HTMLButtonElement>(null);
  const [utilityMenuStyle, setUtilityMenuStyle] = useState<React.CSSProperties>({});
  const volumeWheelMenuTimerRef = useRef<number | null>(null);
  const [suppressOverflowTooltip, setSuppressOverflowTooltip] = useState(false);
  const perfFlags = usePerfProbeFlags();

  useEffect(() => {
    if (!floatingPlayerBar) return;

    const updatePosition = () => {
      const sidebar = document.querySelector('.sidebar') as HTMLElement;
      const queue = document.querySelector('.queue-panel') as HTMLElement;

      const leftOffset = sidebar ? sidebar.getBoundingClientRect().right : 0;
      const rightOffset = queue ? window.innerWidth - queue.getBoundingClientRect().left : 0;

      setFloatingStyle({
        left: leftOffset + 24,
        right: rightOffset + 24,
        width: 'auto',
      });
    };

    updatePosition();

    const observer = new ResizeObserver(updatePosition);
    const sidebar = document.querySelector('.sidebar');
    const queue = document.querySelector('.queue-panel');
    if (sidebar) observer.observe(sidebar);
    if (queue) observer.observe(queue);
    window.addEventListener('resize', updatePosition);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
    };
  }, [floatingPlayerBar]);

  useEffect(() => {
    const updateOverflow = () => {
      const width = playerBarRef.current?.clientWidth ?? window.innerWidth;
      const threshold = floatingPlayerBar ? 980 : 1140;
      setUtilityOverflow(width < threshold);
    };

    updateOverflow();
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateOverflow)
      : null;
    const el = playerBarRef.current;
    if (ro && el) ro.observe(el);
    window.addEventListener('resize', updateOverflow);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', updateOverflow);
    };
  }, [floatingPlayerBar]);

  useEffect(() => {
    if (!utilityOverflow) setUtilityMenuOpen(false);
    if (!utilityOverflow && volumeWheelMenuTimerRef.current != null) {
      window.clearTimeout(volumeWheelMenuTimerRef.current);
      volumeWheelMenuTimerRef.current = null;
    }
  }, [utilityOverflow]);

  useEffect(() => {
    if (!utilityMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (utilityBtnRef.current?.contains(target)) return;
      if (utilityMenuRef.current?.contains(target)) return;
      setUtilityMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUtilityMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [utilityMenuOpen]);

  useEffect(() => () => {
    if (volumeWheelMenuTimerRef.current != null) {
      window.clearTimeout(volumeWheelMenuTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const onToggleEqualizer = () => setEqOpen(v => !v);
    window.addEventListener('psy:toggle-equalizer', onToggleEqualizer);
    return () => window.removeEventListener('psy:toggle-equalizer', onToggleEqualizer);
  }, []);

  useEffect(() => {
    if (!utilityMenuOpen) return;
    const MENU_WIDTH = 238;
    const MARGIN = 8;
    const updateMenuPos = () => {
      const btn = utilityBtnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const left = Math.min(
        Math.max(r.right - MENU_WIDTH, MARGIN),
        window.innerWidth - MENU_WIDTH - MARGIN,
      );
      setUtilityMenuStyle({
        position: 'fixed',
        left,
        width: MENU_WIDTH,
        bottom: window.innerHeight - r.top + 8,
        zIndex: 10050,
      });
    };
    updateMenuPos();
    window.addEventListener('resize', updateMenuPos);
    window.addEventListener('scroll', updateMenuPos, true);
    return () => {
      window.removeEventListener('resize', updateMenuPos);
      window.removeEventListener('scroll', updateMenuPos, true);
    };
  }, [utilityMenuOpen]);

  const { delayModalOpen, setDelayModalOpen, playPauseBind } = usePlaybackDelayPress(togglePlay);
  const transportAnchorRef = useRef<HTMLDivElement>(null);
  const playSlotRef = useRef<HTMLSpanElement>(null);
  const scheduleRemaining = usePlaybackScheduleRemaining();
  const isPreviewing = usePreviewStore(s => s.previewingId !== null);
  const previewAudioStarted = usePreviewStore(s => s.audioStarted);
  const previewingTrack = usePreviewStore(s => s.previewingTrack);

  const isRadio = !!currentRadio;

  // Radio metadata (ICY or AzuraCast) — only active while a radio station is playing.
  const radioMeta = useRadioMetadata(currentRadio ?? null);


  const isStarred = currentTrack
    ? (currentTrack.id in starredOverrides ? starredOverrides[currentTrack.id] : !!currentTrack.starred)
    : false;

  const toggleStar = useCallback(async () => {
    if (!currentTrack) return;
    const next = !isStarred;
    setStarredOverride(currentTrack.id, next);
    try {
      if (next) await star(currentTrack.id, 'song');
      else await unstar(currentTrack.id, 'song');
    } catch {
      setStarredOverride(currentTrack.id, !next);
    }
  }, [currentTrack, isStarred, setStarredOverride]);

  const duration = currentTrack?.duration ?? 0;

  // Cover art: prefer radio station art, fall back to track art.
  // Note: getCoverArt.view needs ra-{id}, not the raw coverArt filename Navidrome returns.
  const radioCoverSrc = useMemo(
    () => currentRadio?.coverArt ? buildCoverArtUrl(`ra-${currentRadio.id}`, 128) : '',
    [currentRadio?.coverArt, currentRadio?.id]
  );
  const radioCoverKey = currentRadio?.coverArt ? coverArtCacheKey(`ra-${currentRadio.id}`, 128) : '';
  // Preview takes visual priority over the queued track in the player-bar info
  // cell, but only when not in radio mode (radio has its own meta layout).
  const showPreviewMeta = isPreviewing && !isRadio && previewingTrack !== null;
  const displayCoverArt = showPreviewMeta ? previewingTrack!.coverArt : currentTrack?.coverArt;
  const displayTitle = showPreviewMeta ? previewingTrack!.title : (currentTrack?.title ?? t('player.noTitle'));
  const displayArtist = showPreviewMeta ? previewingTrack!.artist : (currentTrack?.artist ?? '—');

  const coverSrc = useMemo(() => displayCoverArt ? buildCoverArtUrl(displayCoverArt, 128) : '', [displayCoverArt]);
  const coverKey = displayCoverArt ? coverArtCacheKey(displayCoverArt, 128) : '';

  const handleVolume = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setVolume(parseFloat(e.target.value));
  }, [setVolume]);

  const handleVolumeWheel = useCallback((e: React.WheelEvent<HTMLElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    setVolume(Math.max(0, Math.min(1, volume + delta)));

    if (utilityOverflow) {
      setSuppressOverflowTooltip(true);
      setUtilityMenuMode('volume');
      setUtilityMenuOpen(true);
      if (volumeWheelMenuTimerRef.current != null) {
        window.clearTimeout(volumeWheelMenuTimerRef.current);
      }
      volumeWheelMenuTimerRef.current = window.setTimeout(() => {
        setUtilityMenuOpen(false);
        setSuppressOverflowTooltip(false);
        volumeWheelMenuTimerRef.current = null;
      }, 1000);
    }
  }, [volume, setVolume, utilityOverflow]);

  const volumeStyle = {
    background: `linear-gradient(to right, var(--volume-accent, var(--accent)) ${volume * 100}%, var(--ctp-surface2) ${volume * 100}%)`,
  };

  const playerBarContent = (
    <>
    <footer
      ref={playerBarRef}
      className={`player-bar ${floatingPlayerBar ? 'floating' : ''}${showPreviewMeta ? ' is-previewing' : ''}${showPreviewMeta && previewAudioStarted ? ' audio-started' : ''}`}
      style={floatingPlayerBar ? floatingStyle : undefined}
      role="region"
      aria-label={t('player.regionLabel')}
    >

      {/* Track Info */}
      <div className="player-track-info">
        <div
          className={`player-album-art-wrap ${currentTrack && !isRadio && !showPreviewMeta ? 'clickable' : ''}`}
          onClick={() => !isRadio && !showPreviewMeta && currentTrack && toggleFullscreen()}
          data-tooltip={!isRadio && !showPreviewMeta && currentTrack ? t('player.openFullscreen') : undefined}
        >
          {isRadio ? (
            currentRadio?.coverArt ? (
              <CachedImage
                className="player-album-art"
                src={radioCoverSrc}
                cacheKey={radioCoverKey}
                alt={currentRadio.name}
              />
            ) : (
              <div className="player-album-art-placeholder">
                <Cast size={20} />
              </div>
            )
          ) : displayCoverArt ? (
            <CachedImage
              className="player-album-art"
              src={coverSrc}
              cacheKey={coverKey}
              alt={showPreviewMeta ? `${previewingTrack!.title} Cover` : `${currentTrack?.album ?? ''} Cover`}
            />
          ) : (
            <div className="player-album-art-placeholder">
              <Music size={22} />
            </div>
          )}
          {currentTrack && !isRadio && !showPreviewMeta && (
            <div className="player-art-expand-hint" aria-hidden="true">
              <Maximize2 size={16} />
            </div>
          )}
        </div>
        <div className="player-track-meta">
          {showPreviewMeta && (
            <span className="player-preview-label" aria-label={t('player.previewActive')}>
              {t('player.previewLabel')}
            </span>
          )}
          <MarqueeText
            text={isRadio
              ? (radioMeta.currentTitle
                  ? (radioMeta.currentArtist
                      ? `${radioMeta.currentArtist} — ${radioMeta.currentTitle}`
                      : radioMeta.currentTitle)
                  : (currentRadio?.name ?? '—'))
              : displayTitle}
            className="player-track-name"
            style={{ cursor: !isRadio && !showPreviewMeta && currentTrack?.albumId ? 'pointer' : 'default' }}
            onClick={() => !isRadio && !showPreviewMeta && currentTrack?.albumId && navigate(`/album/${currentTrack.albumId}`)}
            onContextMenu={!isRadio && !showPreviewMeta && currentTrack?.albumId
              ? (e) => {
                  e.preventDefault();
                  const album: SubsonicAlbum = {
                    id: currentTrack.albumId,
                    name: currentTrack.album,
                    artist: currentTrack.artist,
                    artistId: currentTrack.artistId ?? '',
                    coverArt: currentTrack.coverArt,
                    songCount: 0,
                    duration: 0,
                  };
                  openContextMenu(e.clientX, e.clientY, album, 'album');
                }
              : undefined}
          />
          <MarqueeText
            text={isRadio
              ? (radioMeta.currentTitle && currentRadio?.name
                  ? currentRadio.name
                  : t('radio.liveStream'))
              : displayArtist}
            className="player-track-artist"
            style={{ cursor: !isRadio && !showPreviewMeta && currentTrack?.artistId ? 'pointer' : 'default' }}
            onClick={() => !isRadio && !showPreviewMeta && currentTrack?.artistId && navigate(`/artist/${currentTrack.artistId}`)}
          />
          {currentTrack && !isRadio && !showPreviewMeta && (
            <StarRating
              value={userRatingOverrides[currentTrack.id] ?? currentTrack.userRating ?? 0}
              onChange={r => { setUserRatingOverride(currentTrack.id, r); setRating(currentTrack.id, r).catch(() => {}); }}
              className="player-track-rating"
              ariaLabel={t('albumDetail.ratingLabel')}
            />
          )}
          {isRadio && radioMeta.listeners != null && (
            <span className="player-radio-listeners">
              {t('radio.listenerCount', { count: radioMeta.listeners })}
            </span>
          )}
        </div>
        {currentTrack && !isRadio && (
          <button
            className={`player-btn player-btn-sm player-star-btn${isStarred ? ' is-starred' : ''}`}
            onClick={toggleStar}
            aria-label={isStarred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
            data-tooltip={isStarred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
            style={{ flexShrink: 0 }}
          >
            <Heart size={15} fill={isStarred ? 'currentColor' : 'none'} />
          </button>
        )}
        {currentTrack && !isRadio && lastfmSessionKey && (
          <button
            className="player-btn player-btn-sm player-love-btn"
            onClick={toggleLastfmLove}
            aria-label={lastfmLoved ? t('contextMenu.lfmUnlove') : t('contextMenu.lfmLove')}
            data-tooltip={lastfmLoved ? t('contextMenu.lfmUnlove') : t('contextMenu.lfmLove')}
            style={{ color: lastfmLoved ? '#e31c23' : 'var(--text-muted)', flexShrink: 0 }}
          >
            <LastfmIcon size={15} />
          </button>
        )}
      </div>

      {/* Transport Controls */}
      <div className="player-buttons" ref={transportAnchorRef}>
        <button
          className="player-btn player-btn-sm"
          onClick={() => {
            if (isPreviewing) {
              usePreviewStore.setState({ previewingId: null, previewingTrack: null, elapsed: 0 });
              invoke('audio_preview_stop_silent').catch(() => {});
            } else {
              stop();
            }
          }}
          aria-label={isPreviewing ? t('playlists.previewStop') : t('player.stop')}
          data-tooltip={isPreviewing ? t('playlists.previewStop') : t('player.stop')}
        >
          <Square size={14} fill="currentColor" />
        </button>
        <button className="player-btn" onClick={() => previous()} aria-label={t('player.prev')} data-tooltip={t('player.prev')} disabled={isRadio} style={isRadio ? { opacity: 0.3, pointerEvents: 'none' } : undefined}>
          <SkipBack size={19} />
        </button>
        <span className="playback-transport-play-wrap" ref={playSlotRef}>
          <PlaybackScheduleBadge layoutAnchorRef={playSlotRef} />
          {isPreviewing && (
            <svg className="player-btn-preview-ring" viewBox="0 0 100 100" aria-hidden="true">
              <circle cx="50" cy="50" r="47" pathLength="100" className="player-btn-preview-ring-track" />
              <circle cx="50" cy="50" r="47" pathLength="100" className="player-btn-preview-ring-progress" />
            </svg>
          )}
          <button
            className={`player-btn player-btn-primary${isPreviewing ? ' is-previewing' : ''}`}
            type="button"
            {...playPauseBind}
            onClick={isPreviewing
              ? (() => {
                  // Visual is "stop preview"; semantics match the tracklist preview
                  // button — preview ends, main playback auto-resumes if it was
                  // playing before. Use regular audio_preview_stop (not _silent).
                  usePreviewStore.setState({ previewingId: null, previewingTrack: null, elapsed: 0 });
                  invoke('audio_preview_stop').catch(() => {});
                })
              : playPauseBind.onClick}
            aria-label={isPreviewing ? t('playlists.previewStop') : isPlaying ? t('player.pause') : t('player.play')}
            data-tooltip={isPreviewing ? t('playlists.previewStop') : isPlaying ? t('player.pause') : t('player.play')}
          >
            {scheduleRemaining != null ? (
              <span className={`player-btn-schedule-stack player-btn-schedule-stack--${scheduleRemaining.mode}`}>
                {scheduleRemaining.mode === 'pause'
                  ? <Moon size={10} strokeWidth={2.5} />
                  : <Sunrise size={10} strokeWidth={2.5} />}
                <span className="player-btn-schedule-time">{scheduleRemaining.remaining}</span>
              </span>
            ) : isPreviewing ? (
              <Square size={16} fill="currentColor" strokeWidth={0} />
            ) : isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
          </button>
        </span>
        <button className="player-btn" onClick={() => next()} aria-label={t('player.next')} data-tooltip={t('player.next')} disabled={isRadio} style={isRadio ? { opacity: 0.3, pointerEvents: 'none' } : undefined}>
          <SkipForward size={19} />
        </button>
        <button
          className="player-btn player-btn-sm"
          onClick={toggleRepeat}
          aria-label={t('player.repeat')}
          data-tooltip={`${t('player.repeat')}: ${repeatMode === 'off' ? t('player.repeatOff') : repeatMode === 'all' ? t('player.repeatAll') : t('player.repeatOne')}`}
          style={{ color: repeatMode !== 'off' ? 'var(--accent)' : undefined }}
        >
          {repeatMode === 'one' ? <Repeat1 size={14} /> : <Repeat size={14} />}
        </button>
      </div>

      {/* Waveform Seekbar / Radio live bar */}
      <div className="player-waveform-section">
        {isRadio ? (
          <>
            {radioMeta.source === 'azuracast' && radioMeta.elapsed != null && radioMeta.duration != null && radioMeta.duration > 0 ? (
              <>
                <span className="player-time">{formatTime(radioMeta.elapsed)}</span>
                <div className="player-waveform-wrap">
                  <div className="radio-progress-bar">
                    <div
                      className="radio-progress-fill"
                      style={{ width: `${Math.min(100, (radioMeta.elapsed / radioMeta.duration) * 100)}%` }}
                    />
                  </div>
                </div>
                <span className="player-time">{formatTime(radioMeta.duration)}</span>
              </>
            ) : (
              <>
                <PlaybackTime className="player-time" />
                <div className="player-waveform-wrap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span className="radio-live-badge">{t('radio.live')}</span>
                </div>
                <span className="player-time" style={{ opacity: 0 }}>0:00</span>
              </>
            )}
          </>
        ) : (
          <>
            <PlaybackTime className="player-time" />
            <div className="player-waveform-wrap">
              {perfFlags.disableWaveformCanvas
                ? <div className="radio-progress-bar" aria-hidden />
                : <WaveformSeek trackId={currentTrack?.id} />}
            </div>
            <span
              className="player-time player-time-toggle"
              onClick={() => {
                const newVal = !localShowRemaining;
                setLocalShowRemaining(newVal);
                useThemeStore.getState().setShowRemainingTime(newVal);
              }}
              data-tooltip={localShowRemaining ? t('player.showDuration') : t('player.showRemainingTime')}
            >
              {localShowRemaining ? <RemainingTime duration={duration} /> : formatTime(duration)}
              <ArrowLeftRight size={10} style={{ marginLeft: 4, opacity: 0.6 }} />
            </span>
          </>
        )}
      </div>

      {utilityOverflow ? (
        <div className="player-overflow-wrap">
          <button
            ref={utilityBtnRef}
            className={`player-btn player-btn-sm${utilityMenuOpen ? ' active' : ''}`}
            onClick={() => {
              setUtilityMenuMode('full');
              setUtilityMenuOpen(v => !v);
              if (volumeWheelMenuTimerRef.current != null) {
                window.clearTimeout(volumeWheelMenuTimerRef.current);
                volumeWheelMenuTimerRef.current = null;
              }
              setSuppressOverflowTooltip(false);
            }}
            onWheel={handleVolumeWheel}
            aria-label={t('player.moreOptions')}
            data-tooltip={suppressOverflowTooltip ? undefined : t('player.moreOptions')}
          >
            <Ellipsis size={15} />
          </button>
        </div>
      ) : (
        <>
          {/* EQ Button */}
          <button
            className={`player-btn player-btn-sm player-eq-btn ${eqOpen ? 'active' : ''}`}
            onClick={() => setEqOpen(v => !v)}
            aria-label={t('player.equalizer')}
            data-tooltip={t('player.equalizer')}
          >
            <SlidersVertical size={15} />
          </button>

          {/* Mini Player */}
          <button
            className="player-btn player-btn-sm"
            onClick={() => invoke('open_mini_player').catch(() => {})}
            aria-label={t('player.miniPlayer')}
            data-tooltip={t('player.miniPlayer')}
          >
            <PictureInPicture2 size={15} />
          </button>

          {/* Volume */}
          <div className="player-volume-section">
            <button
              className="player-btn player-btn-sm"
              onClick={() => {
                if (volume === 0) {
                  setVolume(premuteVolumeRef.current);
                } else {
                  premuteVolumeRef.current = volume;
                  setVolume(0);
                }
              }}
              aria-label={t('player.volume')}
              style={{ color: 'var(--text-muted)', flexShrink: 0 }}
            >
              {volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            <div className="player-volume-slider-wrap" onWheel={handleVolumeWheel}>
              {showVolPct && (
                <span className="player-volume-pct" style={{ left: `${volume * 100}%` }}>
                  {Math.round(volume * 100)}%
                </span>
              )}
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
                className="player-volume-slider"
                onMouseEnter={() => setShowVolPct(true)}
                onMouseLeave={() => setShowVolPct(false)}
              />
            </div>
          </div>
        </>
      )}

      {/* EQ Popup — rendered via portal to avoid backdrop-filter containing-block issue */}
      {utilityMenuOpen && createPortal(
        <div
          className={`player-overflow-menu${utilityMenuMode === 'volume' ? ' player-overflow-menu--volume-only' : ''}`}
          ref={utilityMenuRef}
          style={utilityMenuStyle}
          onWheel={handleVolumeWheel}
        >
          {utilityMenuMode === 'full' && (
            <div className="player-overflow-menu-row">
              <button
                className={`player-overflow-menu-btn${eqOpen ? ' active' : ''}`}
                onClick={() => {
                  setEqOpen(v => !v);
                  setUtilityMenuOpen(false);
                }}
              >
                <SlidersVertical size={14} />
                {t('player.equalizer')}
              </button>
              <button
                className="player-overflow-menu-btn"
                onClick={() => {
                  invoke('open_mini_player').catch(() => {});
                  setUtilityMenuOpen(false);
                }}
              >
                <PictureInPicture2 size={14} />
                {t('player.miniPlayer')}
              </button>
            </div>
          )}
          {utilityMenuMode === 'full' ? (
            <div className="player-volume-section player-volume-section--menu">
              <button
                className="player-btn player-btn-sm"
                onClick={() => {
                  if (volume === 0) {
                    setVolume(premuteVolumeRef.current);
                  } else {
                    premuteVolumeRef.current = volume;
                    setVolume(0);
                  }
                }}
                aria-label={t('player.volume')}
                style={{ color: 'var(--text-muted)', flexShrink: 0 }}
              >
                {volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
              </button>
              <div className="player-volume-slider-wrap" onWheel={handleVolumeWheel}>
                {showVolPct && (
                  <span className="player-volume-pct" style={{ left: `${volume * 100}%` }}>
                    {Math.round(volume * 100)}%
                  </span>
                )}
                <input
                  type="range"
                  id="player-volume-overflow"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  onChange={handleVolume}
                  style={volumeStyle}
                  aria-label={t('player.volume')}
                  className="player-volume-slider"
                  onMouseEnter={() => setShowVolPct(true)}
                  onMouseLeave={() => setShowVolPct(false)}
                />
              </div>
            </div>
          ) : (
            <div className="player-volume-section player-volume-section--menu">
              <button
                className="player-btn player-btn-sm"
                onClick={() => {
                  if (volume === 0) {
                    setVolume(premuteVolumeRef.current);
                  } else {
                    premuteVolumeRef.current = volume;
                    setVolume(0);
                  }
                }}
                aria-label={t('player.volume')}
                style={{ color: 'var(--text-muted)', flexShrink: 0 }}
              >
                {volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
              </button>
              <div className="player-volume-slider-wrap player-volume-slider-wrap--menu-only" onWheel={handleVolumeWheel}>
                {showVolPct && (
                  <span className="player-volume-pct" style={{ left: `${volume * 100}%` }}>
                    {Math.round(volume * 100)}%
                  </span>
                )}
                <input
                  type="range"
                  id="player-volume-overflow-wheel"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  onChange={handleVolume}
                  style={volumeStyle}
                  aria-label={t('player.volume')}
                  className="player-volume-slider"
                  onMouseEnter={() => setShowVolPct(true)}
                  onMouseLeave={() => setShowVolPct(false)}
                />
              </div>
            </div>
          )}
        </div>,
        document.body
      )}

      {/* EQ Popup — rendered via portal to avoid backdrop-filter containing-block issue */}
      {eqOpen && createPortal(
        <>
          <div className="eq-popup-backdrop" onClick={() => setEqOpen(false)} />
          <div className="eq-popup">
            <div className="eq-popup-header">
              <span className="eq-popup-title">Equalizer</span>
              <button className="eq-popup-close" onClick={() => setEqOpen(false)} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <Equalizer />
          </div>
        </>,
        document.body
      )}

    </footer>
    <PlaybackDelayModal open={delayModalOpen} onClose={() => setDelayModalOpen(false)} anchorRef={transportAnchorRef} />
    </>
  );

  if (floatingPlayerBar) {
    return createPortal(playerBarContent, document.body);
  }

  return playerBarContent;
}
