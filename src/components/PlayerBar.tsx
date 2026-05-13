import { star, unstar } from '../api/subsonicStarRating';
import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { formatTime } from '../utils/playerBarHelpers';
import { PlaybackTime, RemainingTime } from './playerBar/PlaybackClock';
import { PlayerTrackInfo } from './playerBar/PlayerTrackInfo';
import { PlayerTransportControls } from './playerBar/PlayerTransportControls';

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

      <PlayerTrackInfo
        currentTrack={currentTrack}
        currentRadio={currentRadio}
        isRadio={isRadio}
        radioMeta={radioMeta}
        radioCoverSrc={radioCoverSrc}
        radioCoverKey={radioCoverKey}
        coverSrc={coverSrc}
        coverKey={coverKey}
        displayCoverArt={displayCoverArt}
        displayTitle={displayTitle}
        displayArtist={displayArtist}
        showPreviewMeta={showPreviewMeta}
        previewingTrack={previewingTrack}
        isStarred={isStarred}
        toggleStar={toggleStar}
        lastfmSessionKey={lastfmSessionKey}
        lastfmLoved={lastfmLoved}
        toggleLastfmLove={toggleLastfmLove}
        userRatingOverrides={userRatingOverrides}
        setUserRatingOverride={setUserRatingOverride}
        toggleFullscreen={toggleFullscreen}
        navigate={navigate}
        openContextMenu={openContextMenu}
        t={t}
      />

      <PlayerTransportControls
        isPlaying={isPlaying}
        isRadio={isRadio}
        isPreviewing={isPreviewing}
        stop={stop}
        previous={previous}
        next={next}
        toggleRepeat={toggleRepeat}
        repeatMode={repeatMode}
        playPauseBind={playPauseBind}
        scheduleRemaining={scheduleRemaining}
        transportAnchorRef={transportAnchorRef}
        playSlotRef={playSlotRef}
        t={t}
      />

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
