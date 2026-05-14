import React, { memo, useRef } from 'react';
import { Moon, Pause, Play, Sunrise } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '../../store/playerStore';
import { usePlaybackDelayPress } from '../../hooks/usePlaybackDelayPress';
import { usePlaybackScheduleRemaining } from '../../utils/format/playbackScheduleFormat';
import PlaybackDelayModal from '../PlaybackDelayModal';
import PlaybackScheduleBadge from '../PlaybackScheduleBadge';

// Play/Pause button (isolated — subscribes to isPlaying only).
export const FsPlayBtn = memo(function FsPlayBtn({
  controlsAnchorRef,
}: {
  controlsAnchorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const isPlaying  = usePlayerStore(s => s.isPlaying);
  const togglePlay = usePlayerStore(s => s.togglePlay);
  const { delayModalOpen, setDelayModalOpen, playPauseBind } = usePlaybackDelayPress(togglePlay);
  const playSlotRef = useRef<HTMLSpanElement>(null);
  const scheduleRemaining = usePlaybackScheduleRemaining();
  return (
    <>
      <span ref={playSlotRef} className="playback-transport-play-wrap">
        <PlaybackScheduleBadge layoutAnchorRef={playSlotRef} className="playback-schedule-badge--fs" />
        <button
          type="button"
          className="fs-btn fs-btn-play"
          {...playPauseBind}
          aria-label={isPlaying ? t('player.pause') : t('player.play')}
          data-tooltip={isPlaying ? t('player.pause') : t('player.play')}
        >
          {scheduleRemaining != null ? (
            <span className={`player-btn-schedule-stack player-btn-schedule-stack--${scheduleRemaining.mode} player-btn-schedule-stack--fs`}>
              {scheduleRemaining.mode === 'pause'
                ? <Moon size={12} strokeWidth={2.5} />
                : <Sunrise size={12} strokeWidth={2.5} />}
              <span className="player-btn-schedule-time player-btn-schedule-time--fs">{scheduleRemaining.remaining}</span>
            </span>
          ) : isPlaying ? <Pause size={25} /> : <Play size={25} fill="currentColor" />}
        </button>
      </span>
      <PlaybackDelayModal open={delayModalOpen} onClose={() => setDelayModalOpen(false)} anchorRef={controlsAnchorRef} />
    </>
  );
});
