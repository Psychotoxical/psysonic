import React from 'react';
import { RotateCcw } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useAuthStore } from '../../../store/authStore';
import { DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB } from '../../../store/authStoreDefaults';
import { LoudnessLufsButtonGroup } from '../LoudnessLufsButtonGroup';

interface Props {
  preAnalysisEffectiveDb: number;
  t: TFunction;
}

/**
 * Normalization engine picker (Off / ReplayGain / LUFS) plus the
 * engine-specific configuration blocks.
 *
 * - ReplayGain → mode (auto/track/album), pre-gain slider, fallback gain.
 *   `auto` mode toggles between track/album based on what the playlist
 *   provides; the help line explains that.
 * - Loudness → target LUFS button group + pre-analysis attenuation slider
 *   with reset-to-default. The effective dB readout reflects how much
 *   headroom is being applied for the current target.
 *
 * Switching engines clears the other engine's enabled flag so only one
 * can be live at a time.
 */
export function NormalizationBlock({ preAnalysisEffectiveDb, t }: Props) {
  const auth = useAuthStore();

  return (
    <>
      <div style={{ marginBottom: '0.6rem' }}>
        <div style={{ fontWeight: 500 }}>{t('settings.normalization', { defaultValue: 'Normalization' })}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
          {t('settings.normalizationDesc')}
        </div>
      </div>
      <div className="settings-segmented" style={{ marginBottom: auth.normalizationEngine === 'off' ? 0 : '0.85rem' }}>
        <button
          type="button"
          className={`btn ${auth.normalizationEngine === 'off' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => {
            auth.setReplayGainEnabled(false);
            auth.setNormalizationEngine('off');
          }}
        >
          {t('settings.normalizationOff')}
        </button>
        <button
          type="button"
          className={`btn ${auth.normalizationEngine === 'replaygain' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => {
            auth.setReplayGainEnabled(true);
            auth.setNormalizationEngine('replaygain');
          }}
        >
          {t('settings.normalizationReplayGain')}
        </button>
        <button
          type="button"
          className={`btn ${auth.normalizationEngine === 'loudness' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => {
            auth.setReplayGainEnabled(false);
            if (auth.normalizationEngine !== 'loudness') auth.setLoudnessTargetLufs(-12);
            auth.setNormalizationEngine('loudness');
          }}
        >
          {t('settings.normalizationLufs')}
        </button>
      </div>
      {auth.normalizationEngine === 'replaygain' && (
        <div className="settings-norm-block">
          <div className="settings-norm-field">
            <div className="settings-norm-row">
              <span className="settings-norm-label">{t('settings.replayGainMode')}</span>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <button
                  className={`btn ${auth.replayGainMode === 'auto' ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ fontSize: 12, padding: '4px 14px' }}
                  onClick={() => auth.setReplayGainMode('auto')}
                >
                  {t('settings.replayGainAuto')}
                </button>
                <button
                  className={`btn ${auth.replayGainMode === 'track' ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ fontSize: 12, padding: '4px 14px' }}
                  onClick={() => auth.setReplayGainMode('track')}
                >
                  {t('settings.replayGainTrack')}
                </button>
                <button
                  className={`btn ${auth.replayGainMode === 'album' ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ fontSize: 12, padding: '4px 14px' }}
                  onClick={() => auth.setReplayGainMode('album')}
                >
                  {t('settings.replayGainAlbum')}
                </button>
              </div>
            </div>
            {auth.replayGainMode === 'auto' && (
              <div className="settings-norm-help">{t('settings.replayGainAutoDesc')}</div>
            )}
          </div>
          <div className="settings-norm-field">
            <div className="settings-norm-row">
              <span className="settings-norm-label">{t('settings.replayGainPreGain')}</span>
              <input
                type="range" min={0} max={6} step={0.5}
                value={auth.replayGainPreGainDb}
                onChange={e => auth.setReplayGainPreGainDb(Number(e.target.value))}
              />
              <span className="settings-norm-value">
                {auth.replayGainPreGainDb > 0 ? `+${auth.replayGainPreGainDb}` : auth.replayGainPreGainDb} dB
              </span>
            </div>
            <div className="settings-norm-help">{t('settings.replayGainPreGainDesc')}</div>
          </div>
          <div className="settings-norm-field">
            <div className="settings-norm-row">
              <span className="settings-norm-label">{t('settings.replayGainFallback')}</span>
              <input
                type="range" min={-6} max={0} step={0.5}
                value={auth.replayGainFallbackDb}
                onChange={e => auth.setReplayGainFallbackDb(Number(e.target.value))}
              />
              <span className="settings-norm-value">
                {auth.replayGainFallbackDb > 0 ? `+${auth.replayGainFallbackDb}` : auth.replayGainFallbackDb} dB
              </span>
            </div>
            <div className="settings-norm-help">{t('settings.replayGainFallbackDesc')}</div>
          </div>
        </div>
      )}
      {auth.normalizationEngine === 'loudness' && (
        <div className="settings-norm-block">
          <div className="settings-norm-field">
            <div className="settings-norm-row">
              <span className="settings-norm-label">{t('settings.loudnessTargetLufs')}</span>
              <LoudnessLufsButtonGroup value={auth.loudnessTargetLufs} onSelect={auth.setLoudnessTargetLufs} />
            </div>
            <div className="settings-norm-help">{t('settings.loudnessTargetLufsDesc')}</div>
          </div>
          <div className="settings-norm-field">
            <div className="settings-norm-row">
              <span className="settings-norm-label">{t('settings.loudnessPreAnalysisAttenuation')}</span>
              <input
                type="range"
                min={-24}
                max={0}
                step={0.5}
                value={auth.loudnessPreAnalysisAttenuationDb}
                onChange={e => auth.setLoudnessPreAnalysisAttenuationDb(Number(e.target.value))}
              />
              <span className="settings-norm-value">
                {preAnalysisEffectiveDb} dB
              </span>
              <button
                type="button"
                className="icon-btn"
                style={{ flexShrink: 0 }}
                disabled={
                  auth.loudnessPreAnalysisAttenuationDb === DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB
                }
                onClick={() => auth.resetLoudnessPreAnalysisAttenuationDbDefault()}
                data-tooltip={t('settings.loudnessPreAnalysisAttenuationReset')}
                aria-label={t('settings.loudnessPreAnalysisAttenuationReset')}
              >
                <RotateCcw size={15} />
              </button>
            </div>
            <div className="settings-norm-help">
              {t('settings.loudnessPreAnalysisAttenuationDesc')}{' '}
              {t('settings.loudnessPreAnalysisAttenuationRef', {
                ref: auth.loudnessPreAnalysisAttenuationDb,
                eff: preAnalysisEffectiveDb,
                tgt: auth.loudnessTargetLufs,
              })}
            </div>
          </div>
          <div className="settings-norm-note">{t('settings.loudnessFirstPlayNote')}</div>
        </div>
      )}
    </>
  );
}
