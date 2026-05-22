import React, { useCallback } from 'react';
import type { TFunction } from 'i18next';
import {
  PLAYBACK_PITCH_MAX,
  PLAYBACK_PITCH_MIN,
  PLAYBACK_PITCH_STEP,
  PLAYBACK_SPEED_MAX,
  PLAYBACK_SPEED_MIN,
  PLAYBACK_SPEED_PRESETS,
  PLAYBACK_SPEED_STEP,
  PLAYBACK_STRATEGIES,
  clampPlaybackPitch,
  clampPlaybackSpeed,
  derivedVarispeedSemitones,
  formatPitchLabel,
  formatSpeedLabel,
  isPlaybackRateApplied,
  type PlaybackStrategy,
} from '../../../utils/audio/playbackRateHelpers';
import { usePlaybackRateStore } from '../../../store/playbackRateStore';
import { useOrbitStore } from '../../../store/orbitStore';
import { isOrbitPlaybackSyncActive } from '../../../utils/orbit';

interface Props {
  t: TFunction;
  /** When false, hide master enable (player popup). */
  showEnable?: boolean;
}

export function PlaybackRateControls({ t, showEnable = true }: Props) {
  const compact = !showEnable;
  const enabled = usePlaybackRateStore(s => s.enabled);
  const strategy = usePlaybackRateStore(s => s.strategy);
  const speed = usePlaybackRateStore(s => s.speed);
  const pitchSemitones = usePlaybackRateStore(s => s.pitchSemitones);
  const {
    setEnabled,
    setStrategy,
    setSpeed,
    setPitchSemitones,
    applyPresetSpeed,
  } = usePlaybackRateStore();
  const orbitRole = useOrbitStore(s => s.role);
  const orbitPhase = useOrbitStore(s => s.phase);

  const orbitActive = isOrbitPlaybackSyncActive(orbitRole, orbitPhase);
  const effectActive = isPlaybackRateApplied(enabled, strategy, speed, pitchSemitones, orbitActive);
  const derivedPitch = derivedVarispeedSemitones(speed);

  const strategyLabel = (s: PlaybackStrategy) => {
    switch (s) {
      case 'speed_corrected':
        return t('settings.playbackRateStrategySpeed');
      case 'varispeed':
        return t('settings.playbackRateStrategyVarispeed');
      case 'preserve_pitch':
        return t('settings.playbackRateStrategyPreserve');
    }
  };

  const handleWheelSpeed = useCallback((e: React.WheelEvent<HTMLElement>) => {
    if (!compact || !enabled) return;
    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY > 0 ? -PLAYBACK_SPEED_STEP : PLAYBACK_SPEED_STEP;
    setSpeed(clampPlaybackSpeed(speed + delta));
  }, [compact, enabled, speed, setSpeed]);

  const handleWheelPitch = useCallback((e: React.WheelEvent<HTMLElement>) => {
    if (!compact || !enabled || strategy !== 'preserve_pitch') return;
    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY > 0 ? -PLAYBACK_PITCH_STEP : PLAYBACK_PITCH_STEP;
    setPitchSemitones(clampPlaybackPitch(pitchSemitones + delta));
  }, [compact, enabled, strategy, pitchSemitones, setPitchSemitones]);

  return (
    <div
      className={`playback-rate-controls${compact ? ' playback-rate-controls--compact' : ''}`}
      onWheel={compact ? handleWheelSpeed : undefined}
    >
      {showEnable && (
        <div className="settings-toggle-row">
          <div>
            <div style={{ fontWeight: 500 }}>{t('settings.playbackRateEnabled')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {t('settings.playbackRateEnabledDesc')}
            </div>
          </div>
          <label className="toggle-switch" aria-label={t('settings.playbackRateEnabled')}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => setEnabled(e.target.checked)}
            />
            <span className="toggle-track" />
          </label>
        </div>
      )}

      {(!showEnable || enabled) && (
        <>
          {showEnable && <div className="divider" />}

          <div className="playback-rate-strategy-row">
            {!compact && (
              <span className="playback-rate-label">{t('settings.playbackRateStrategy')}</span>
            )}
            <div className="playback-rate-strategy-btns">
              {PLAYBACK_STRATEGIES.map(s => (
                <button
                  key={s}
                  type="button"
                  className={`btn btn-sm ${strategy === s ? 'btn-primary' : 'btn-surface'}`}
                  onClick={() => setStrategy(s)}
                >
                  {strategyLabel(s)}
                </button>
              ))}
            </div>
          </div>

          <div className="playback-rate-slider-row">
            {!compact && (
              <span className="playback-rate-label">{t('settings.playbackRateSpeed')}</span>
            )}
            <input
              type="range"
              min={PLAYBACK_SPEED_MIN}
              max={PLAYBACK_SPEED_MAX}
              step={PLAYBACK_SPEED_STEP}
              value={speed}
              onChange={e => setSpeed(parseFloat(e.target.value))}
              className="playback-rate-slider"
              aria-label={t('settings.playbackRateSpeed')}
            />
            <span className="playback-rate-value">{formatSpeedLabel(speed)}</span>
          </div>

          <div className="playback-rate-presets">
            {PLAYBACK_SPEED_PRESETS.map(preset => (
              <button
                key={preset}
                type="button"
                className={`btn btn-sm ${Math.abs(speed - preset) < 0.001 ? 'btn-primary' : 'btn-surface'}`}
                onClick={() => applyPresetSpeed(preset)}
              >
                {formatSpeedLabel(preset)}
              </button>
            ))}
          </div>

          {strategy === 'varispeed' && !compact && (
            <div className="playback-rate-derived" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {t('settings.playbackRateDerivedPitch', {
                value: formatPitchLabel(derivedPitch),
              })}
            </div>
          )}

          {strategy === 'speed_corrected' && !compact && (
            <div className="playback-rate-derived" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {t('settings.playbackRateAutoPitch')}
            </div>
          )}

          {strategy === 'preserve_pitch' && (
            <div className="playback-rate-slider-row" onWheel={compact ? handleWheelPitch : undefined}>
              {!compact && (
                <span className="playback-rate-label">{t('settings.playbackRatePitch')}</span>
              )}
              <input
                type="range"
                min={PLAYBACK_PITCH_MIN}
                max={PLAYBACK_PITCH_MAX}
                step={PLAYBACK_PITCH_STEP}
                value={pitchSemitones}
                onChange={e => setPitchSemitones(parseFloat(e.target.value))}
                className="playback-rate-slider"
                aria-label={t('settings.playbackRatePitch')}
              />
              <span className="playback-rate-value">{formatPitchLabel(pitchSemitones)}</span>
            </div>
          )}

          {!compact && (
            <p className="playback-rate-hint" style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
              {t('settings.playbackRateHint')}
            </p>
          )}

          {orbitActive && enabled && (
            <p className="playback-rate-orbit" style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
              {t(compact ? 'settings.playbackRateOrbitPausedShort' : 'settings.playbackRateOrbitPaused')}
            </p>
          )}

          {!compact && !effectActive && enabled && !orbitActive && (
            <p className="playback-rate-neutral" style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
              {t('settings.playbackRateNeutral')}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function PlaybackRateBlock({ t }: { t: TFunction }) {
  return <PlaybackRateControls t={t} showEnable />;
}
