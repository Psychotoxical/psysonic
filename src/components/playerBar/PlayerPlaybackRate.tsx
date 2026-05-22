import React, { useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { TFunction } from 'i18next';
import { PlaybackRateControls } from '../settings/audio/PlaybackRateBlock';
import { usePlaybackRateStore } from '../../store/playbackRateStore';
import { useOrbitStore } from '../../store/orbitStore';
import {
  PLAYBACK_SPEED_STEP,
  clampPlaybackSpeed,
  formatSpeedLabel,
  isPlaybackRateApplied,
} from '../../utils/audio/playbackRateHelpers';
import { isOrbitPlaybackSyncActive } from '../../utils/orbit';
import { usePlayerBarAnchoredPopover } from '../../hooks/usePlayerBarAnchoredPopover';

const POPOVER_WIDTH = 320;

interface Props {
  t: TFunction;
}

export function PlayerPlaybackRateMenuSection({ t }: Props) {
  const enabled = usePlaybackRateStore(s => s.enabled);
  if (!enabled) return null;
  return (
    <div className="player-playback-rate-menu-section">
      <PlaybackRateControls t={t} showEnable={false} />
    </div>
  );
}

export function PlayerPlaybackRate({ t }: Props) {
  const enabled = usePlaybackRateStore(s => s.enabled);
  const strategy = usePlaybackRateStore(s => s.strategy);
  const speed = usePlaybackRateStore(s => s.speed);
  const pitchSemitones = usePlaybackRateStore(s => s.pitchSemitones);
  const setSpeed = usePlaybackRateStore(s => s.setSpeed);
  const orbitRole = useOrbitStore(s => s.role);
  const orbitPhase = useOrbitStore(s => s.phase);
  const { open, setOpen, popStyle, btnRef, popRef } = usePlayerBarAnchoredPopover(POPOVER_WIDTH);

  const orbitActive = isOrbitPlaybackSyncActive(orbitRole, orbitPhase);
  const effectActive = isPlaybackRateApplied(enabled, strategy, speed, pitchSemitones, orbitActive);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLElement>) => {
    if (!enabled) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -PLAYBACK_SPEED_STEP : PLAYBACK_SPEED_STEP;
    setSpeed(clampPlaybackSpeed(speed + delta));
  }, [enabled, speed, setSpeed]);

  if (!enabled) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`player-btn player-btn-sm player-playback-rate-btn${open ? ' active' : ''}${effectActive ? ' player-playback-rate-btn--live' : ''}`}
        onClick={() => setOpen(v => !v)}
        onWheel={handleWheel}
        aria-label={t('player.playbackRate')}
        aria-expanded={open}
        data-tooltip={t('player.playbackRate')}
      >
        {formatSpeedLabel(speed)}
      </button>

      {open && createPortal(
        <div
          ref={popRef}
          className="player-playback-rate-popover"
          style={popStyle}
        >
          <PlaybackRateControls t={t} showEnable={false} />
        </div>,
        document.body,
      )}
    </>
  );
}
