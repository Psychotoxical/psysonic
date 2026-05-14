import React from 'react';
import { Moon, Pause, Play, Repeat, Repeat1, SkipBack, SkipForward, Square, Sunrise } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { TFunction } from 'i18next';
import type { PlayerState } from '../../store/playerStoreTypes';
import { usePreviewStore } from '../../store/previewStore';
import PlaybackScheduleBadge from '../PlaybackScheduleBadge';
import { usePlaybackDelayPress } from '../../hooks/usePlaybackDelayPress';
import { usePlaybackScheduleRemaining } from '../../utils/format/playbackScheduleFormat';

type RepeatMode = PlayerState['repeatMode'];
type PlayPauseBind = ReturnType<typeof usePlaybackDelayPress>['playPauseBind'];
type ScheduleRemaining = ReturnType<typeof usePlaybackScheduleRemaining>;

interface Props {
  isPlaying: boolean;
  isRadio: boolean;
  isPreviewing: boolean;
  stop: () => void;
  previous: () => void;
  next: () => void;
  toggleRepeat: () => void;
  repeatMode: RepeatMode;
  playPauseBind: PlayPauseBind;
  scheduleRemaining: ScheduleRemaining;
  transportAnchorRef: React.RefObject<HTMLDivElement | null>;
  playSlotRef: React.RefObject<HTMLSpanElement | null>;
  t: TFunction;
}

export function PlayerTransportControls({
  isPlaying, isRadio, isPreviewing, stop, previous, next, toggleRepeat, repeatMode,
  playPauseBind, scheduleRemaining, transportAnchorRef, playSlotRef, t,
}: Props) {
  return (
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
      <button
        className="player-btn"
        onClick={() => previous()}
        aria-label={t('player.prev')}
        data-tooltip={t('player.prev')}
        disabled={isRadio}
        style={isRadio ? { opacity: 0.3, pointerEvents: 'none' } : undefined}
      >
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
      <button
        className="player-btn"
        onClick={() => next()}
        aria-label={t('player.next')}
        data-tooltip={t('player.next')}
        disabled={isRadio}
        style={isRadio ? { opacity: 0.3, pointerEvents: 'none' } : undefined}
      >
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
  );
}
