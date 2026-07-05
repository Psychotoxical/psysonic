import React, { useCallback } from 'react';
import type { TFunction } from 'i18next';
import {
  PLAYBACK_PITCH_MAX,
  PLAYBACK_PITCH_MIN,
  PLAYBACK_SPEED_MAX,
  PLAYBACK_SPEED_MIN,
  PLAYBACK_SPEED_PRESETS,
  PLAYBACK_STRATEGIES,
  clampPlaybackPitch,
  clampPlaybackSpeed,
  derivedVarispeedSemitones,
  formatPitchLabel,
  formatSpeedLabel,
  isPlaybackRateApplied,
  playbackPitchStep,
  playbackSpeedStep,
  varispeedSpeedFromSemitones,
  type PlaybackStrategy,
} from '@/features/playback/utils/audio/playbackRateHelpers';
import { usePlaybackRateStore } from '@/features/playback/store/playbackRateStore';
import { useOrbitStore } from '@/features/orbit';
import { useAuthStore } from '@/store/authStore';
import { isOrbitPlaybackSyncActive } from '@/features/orbit';
import { SettingsToggle } from '@/features/settings/components/SettingsToggle';
import { SettingsSubCard } from '@/features/settings/components/SettingsSubCard';

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
  const fineStep = usePlaybackRateStore(s => s.fineStep);
  const {
    setEnabled,
    setStrategy,
    setSpeed,
    setPitchSemitones,
    applyPresetSpeed,
    setFineStep,
  } = usePlaybackRateStore();
  const orbitRole = useOrbitStore(s => s.role);
  const orbitPhase = useOrbitStore(s => s.phase);
  const advancedSettingsEnabled = useAuthStore(s => s.advancedSettingsEnabled);

  const orbitActive = isOrbitPlaybackSyncActive(orbitRole, orbitPhase);
  const effectActive = isPlaybackRateApplied(enabled, strategy, speed, pitchSemitones, orbitActive);
  const derivedPitch = derivedVarispeedSemitones(speed);
  const speedStep = playbackSpeedStep(fineStep);
  const pitchStep = playbackPitchStep(fineStep);
  const pitchDecimals = fineStep ? 2 : 1;

  const strategyLabel = (s: PlaybackStrategy) => {
    switch (s) {
      case 'speed_corrected':
        return t('settings.playbackRateStrategySpeed');
      case 'varispeed':
        return t('settings.playbackRateStrategyVarispeed');
      case 'varispeed_semitones':
        return t('settings.playbackRateStrategyVarispeedSemitones');
      case 'preserve_pitch':
        return t('settings.playbackRateStrategyPreserve');
    }
  };

  const strategyTip = (s: PlaybackStrategy) => {
    switch (s) {
      case 'speed_corrected':
        return t('settings.playbackRateStrategySpeedTip');
      case 'varispeed':
        return t('settings.playbackRateStrategyVarispeedTip');
      case 'varispeed_semitones':
        return t('settings.playbackRateStrategyVarispeedSemitonesTip');
      case 'preserve_pitch':
        return t('settings.playbackRateStrategyPreserveTip');
    }
  };

  const handleWheelSpeed = useCallback((e: React.WheelEvent<HTMLElement>) => {
    if (!compact || !enabled) return;
    e.preventDefault();
    e.stopPropagation();
    if (strategy === 'varispeed_semitones') {
      const step = e.deltaY > 0 ? -pitchStep : pitchStep;
      const st = clampPlaybackPitch(derivedVarispeedSemitones(speed) + step);
      setSpeed(clampPlaybackSpeed(varispeedSpeedFromSemitones(st)));
      return;
    }
    const delta = e.deltaY > 0 ? -speedStep : speedStep;
    setSpeed(clampPlaybackSpeed(speed + delta));
  }, [compact, enabled, strategy, speed, speedStep, pitchStep, setSpeed]);

  const handleWheelPitch = useCallback((e: React.WheelEvent<HTMLElement>) => {
    if (!compact || !enabled || strategy !== 'preserve_pitch') return;
    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY > 0 ? -pitchStep : pitchStep;
    setPitchSemitones(clampPlaybackPitch(pitchSemitones + delta));
  }, [compact, enabled, strategy, pitchSemitones, pitchStep, setPitchSemitones]);

  return (
    <div
      className={`playback-rate-controls${compact ? ' playback-rate-controls--compact' : ''}`}
      onWheel={compact ? handleWheelSpeed : undefined}
    >
      {showEnable && (
        <SettingsToggle
          label={t('settings.playbackRateEnabled')}
          desc={t('settings.playbackRateEnabledDesc')}
          checked={enabled}
          onChange={setEnabled}
        />
      )}

      {(!showEnable || enabled) && (() => {
        const body = (
          <>
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
                  data-tooltip={strategyTip(s)}
                  data-tooltip-wrap=""
                >
                  {strategyLabel(s)}
                </button>
              ))}
            </div>
          </div>

          {strategy !== 'varispeed_semitones' && (
            <div className="playback-rate-slider-row">
              {!compact && (
                <span className="playback-rate-label">{t('settings.playbackRateSpeed')}</span>
              )}
              <input
                type="range"
                min={PLAYBACK_SPEED_MIN}
                max={PLAYBACK_SPEED_MAX}
                step={speedStep}
                value={speed}
                onChange={e => setSpeed(parseFloat(e.target.value))}
                className="playback-rate-slider"
                aria-label={t('settings.playbackRateSpeed')}
              />
              <span className="playback-rate-value">{formatSpeedLabel(speed)}</span>
            </div>
          )}

          {strategy === 'varispeed_semitones' && (
            <div className="playback-rate-slider-row">
              {!compact && (
                <span className="playback-rate-label">{t('settings.playbackRatePitch')}</span>
              )}
              <input
                type="range"
                min={PLAYBACK_PITCH_MIN}
                max={PLAYBACK_PITCH_MAX}
                step={pitchStep}
                value={clampPlaybackPitch(derivedPitch)}
                onChange={e =>
                  setSpeed(clampPlaybackSpeed(varispeedSpeedFromSemitones(parseFloat(e.target.value))))
                }
                className="playback-rate-slider"
                aria-label={t('settings.playbackRatePitch')}
              />
              <span className="playback-rate-value">{formatPitchLabel(derivedPitch, pitchDecimals)}</span>
            </div>
          )}

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
                value: formatPitchLabel(derivedPitch, pitchDecimals),
              })}
            </div>
          )}

          {strategy === 'varispeed_semitones' && !compact && (
            <div className="playback-rate-derived" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {t('settings.playbackRateDerivedSpeed', {
                value: formatSpeedLabel(speed),
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
                step={pitchStep}
                value={pitchSemitones}
                onChange={e => setPitchSemitones(parseFloat(e.target.value))}
                className="playback-rate-slider"
                aria-label={t('settings.playbackRatePitch')}
              />
              <span className="playback-rate-value">{formatPitchLabel(pitchSemitones, pitchDecimals)}</span>
            </div>
          )}

          {!compact && advancedSettingsEnabled && (
            <div className="settings-toggle-row">
              <div>
                <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {t('settings.playbackRateFineStep')}
                  <span
                    className="settings-sub-section-advanced-badge"
                    style={{ marginRight: 0 }}
                    aria-hidden="true"
                  >
                    {t('settings.advancedBadge')}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('settings.playbackRateFineStepDesc')}
                </div>
              </div>
              <label className="toggle-switch" aria-label={t('settings.playbackRateFineStep')}>
                <input
                  type="checkbox"
                  checked={fineStep}
                  onChange={e => setFineStep(e.target.checked)}
                />
                <span className="toggle-track" />
              </label>
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
        );
        return compact
          ? body
          : <SettingsSubCard style={{ marginTop: '0.85rem' }}>{body}</SettingsSubCard>;
      })()}
    </div>
  );
}

export function PlaybackRateBlock({ t }: { t: TFunction }) {
  return <PlaybackRateControls t={t} showEnable />;
}
