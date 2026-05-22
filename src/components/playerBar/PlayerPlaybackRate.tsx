import React, { useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
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

interface Props {
  t: TFunction;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}

export function PlayerPlaybackRate({ t, open, onToggle, onClose }: Props) {
  const enabled = usePlaybackRateStore(s => s.enabled);
  const strategy = usePlaybackRateStore(s => s.strategy);
  const speed = usePlaybackRateStore(s => s.speed);
  const pitchSemitones = usePlaybackRateStore(s => s.pitchSemitones);
  const setSpeed = usePlaybackRateStore(s => s.setSpeed);
  const orbitRole = useOrbitStore(s => s.role);
  const orbitPhase = useOrbitStore(s => s.phase);
  const sliderWrapRef = useRef<HTMLDivElement>(null);

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
        type="button"
        className={`player-btn player-btn-sm player-playback-rate-btn${open ? ' active' : ''}${effectActive ? ' player-playback-rate-btn--live' : ''}`}
        onClick={onToggle}
        onWheel={handleWheel}
        aria-label={t('player.playbackRate')}
        data-tooltip={t('player.playbackRate')}
      >
        {formatSpeedLabel(speed)}
      </button>

      {open && createPortal(
        <>
          <div className="eq-popup-backdrop" onClick={onClose} />
          <div className="eq-popup playback-rate-popup">
            <div className="eq-popup-header">
              <span className="eq-popup-title">{t('settings.playbackRateTitle')}</span>
              <button type="button" className="eq-popup-close" onClick={onClose} aria-label={t('common.close')}>
                <X size={16} />
              </button>
            </div>
            <div ref={sliderWrapRef} onWheel={handleWheel}>
              <PlaybackRateControls t={t} showEnable={false} />
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
