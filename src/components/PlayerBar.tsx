import { star, unstar } from '../api/subsonicStarRating';
import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  SlidersVertical, X,
  PictureInPicture2, Ellipsis,
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
import { usePlaybackScheduleRemaining } from '../utils/format/playbackScheduleFormat';
import { usePreviewStore } from '../store/previewStore';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { formatTime } from '../utils/componentHelpers/playerBarHelpers';
import { PlaybackTime, RemainingTime } from './playerBar/PlaybackClock';
import { PlayerTrackInfo } from './playerBar/PlayerTrackInfo';
import { PlayerTransportControls } from './playerBar/PlayerTransportControls';
import { PlayerSeekbarSection } from './playerBar/PlayerSeekbarSection';
import { PlayerVolume } from './playerBar/PlayerVolume';
import { PlayerOverflowMenu } from './playerBar/PlayerOverflowMenu';
import { useFloatingPlayerBar } from '../hooks/useFloatingPlayerBar';
import { useUtilityOverflowMenu } from '../hooks/useUtilityOverflowMenu';

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
  const playerBarRef = useRef<HTMLElement>(null);
  const perfFlags = usePerfProbeFlags();

  const floatingStyle = useFloatingPlayerBar(playerBarRef, floatingPlayerBar);

  const {
    utilityOverflow,
    utilityMenuOpen,
    setUtilityMenuOpen,
    utilityMenuMode,
    setUtilityMenuMode,
    utilityMenuStyle,
    utilityMenuRef,
    utilityBtnRef,
    volumeWheelMenuTimerRef,
    suppressOverflowTooltip,
    setSuppressOverflowTooltip,
  } = useUtilityOverflowMenu(playerBarRef, floatingPlayerBar);

  useEffect(() => {
    const onToggleEqualizer = () => setEqOpen(v => !v);
    window.addEventListener('psy:toggle-equalizer', onToggleEqualizer);
    return () => window.removeEventListener('psy:toggle-equalizer', onToggleEqualizer);
  }, []);

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

      <PlayerSeekbarSection
        isRadio={isRadio}
        radioMeta={radioMeta}
        trackId={currentTrack?.id}
        duration={duration}
        localShowRemaining={localShowRemaining}
        setLocalShowRemaining={setLocalShowRemaining}
        disableWaveformCanvas={perfFlags.disableWaveformCanvas}
        t={t}
      />

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
          <button
            className={`player-btn player-btn-sm player-eq-btn ${eqOpen ? 'active' : ''}`}
            onClick={() => setEqOpen(v => !v)}
            aria-label={t('player.equalizer')}
            data-tooltip={t('player.equalizer')}
          >
            <SlidersVertical size={15} />
          </button>

          <button
            className="player-btn player-btn-sm"
            onClick={() => invoke('open_mini_player').catch(() => {})}
            aria-label={t('player.miniPlayer')}
            data-tooltip={t('player.miniPlayer')}
          >
            <PictureInPicture2 size={15} />
          </button>

          <PlayerVolume
            volume={volume}
            setVolume={setVolume}
            premuteVolumeRef={premuteVolumeRef}
            showVolPct={showVolPct}
            setShowVolPct={setShowVolPct}
            handleVolume={handleVolume}
            handleVolumeWheel={handleVolumeWheel}
            volumeStyle={volumeStyle}
            inputId="player-volume"
            t={t}
          />
        </>
      )}

      {utilityMenuOpen && (
        <PlayerOverflowMenu
          utilityMenuRef={utilityMenuRef}
          utilityMenuStyle={utilityMenuStyle}
          utilityMenuMode={utilityMenuMode}
          eqOpen={eqOpen}
          setEqOpen={setEqOpen}
          closeMenu={() => setUtilityMenuOpen(false)}
          volume={volume}
          setVolume={setVolume}
          premuteVolumeRef={premuteVolumeRef}
          showVolPct={showVolPct}
          setShowVolPct={setShowVolPct}
          handleVolume={handleVolume}
          handleVolumeWheel={handleVolumeWheel}
          volumeStyle={volumeStyle}
          t={t}
        />
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
