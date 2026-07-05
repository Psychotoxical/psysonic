import React from 'react';
import { RotateCcw } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useAuthStore } from '@/store/authStore';
import { DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB } from '@/store/authStoreDefaults';
import { LoudnessLufsButtonGroup } from '@/features/settings/components/LoudnessLufsButtonGroup';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { SettingsSubCard, SettingsField, SettingsValue, SettingsCallout } from '@/features/settings/components/SettingsSubCard';

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
 *
 * Rendered as its own top-level "Normalization" category in the Audio tab, so
 * the boxed `SettingsGroup` is title-less — the `SettingsSubSection` header and
 * description name it.
 */
export function NormalizationBlock({ preAnalysisEffectiveDb, t }: Props) {
  const auth = useAuthStore();

  return (
    <SettingsGroup>
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
        <SettingsSubCard>
          <SettingsField
            label={t('settings.replayGainMode')}
            desc={auth.replayGainMode === 'auto' ? t('settings.replayGainAutoDesc') : undefined}
            row
          >
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
          </SettingsField>
          <SettingsField label={t('settings.replayGainPreGain')} desc={t('settings.replayGainPreGainDesc')} row>
            <input
              type="range" min={0} max={6} step={0.5}
              value={auth.replayGainPreGainDb}
              onChange={e => auth.setReplayGainPreGainDb(Number(e.target.value))}
            />
            <SettingsValue>
              {auth.replayGainPreGainDb > 0 ? `+${auth.replayGainPreGainDb}` : auth.replayGainPreGainDb} dB
            </SettingsValue>
          </SettingsField>
          <SettingsField label={t('settings.replayGainFallback')} desc={t('settings.replayGainFallbackDesc')} row>
            <input
              type="range" min={-6} max={0} step={0.5}
              value={auth.replayGainFallbackDb}
              onChange={e => auth.setReplayGainFallbackDb(Number(e.target.value))}
            />
            <SettingsValue>
              {auth.replayGainFallbackDb > 0 ? `+${auth.replayGainFallbackDb}` : auth.replayGainFallbackDb} dB
            </SettingsValue>
          </SettingsField>
        </SettingsSubCard>
      )}
      {auth.normalizationEngine === 'loudness' && (
        <SettingsSubCard>
          <SettingsField label={t('settings.loudnessTargetLufs')} desc={t('settings.loudnessTargetLufsDesc')} row>
            <LoudnessLufsButtonGroup value={auth.loudnessTargetLufs} onSelect={auth.setLoudnessTargetLufs} />
          </SettingsField>
          <SettingsField
            label={t('settings.loudnessPreAnalysisAttenuation')}
            desc={
              <>
                {t('settings.loudnessPreAnalysisAttenuationDesc')}{' '}
                {t('settings.loudnessPreAnalysisAttenuationRef', {
                  ref: auth.loudnessPreAnalysisAttenuationDb,
                  eff: preAnalysisEffectiveDb,
                  tgt: auth.loudnessTargetLufs,
                })}
              </>
            }
            row
          >
            <input
              type="range"
              min={-24}
              max={0}
              step={0.5}
              value={auth.loudnessPreAnalysisAttenuationDb}
              onChange={e => auth.setLoudnessPreAnalysisAttenuationDb(Number(e.target.value))}
            />
            <SettingsValue>{preAnalysisEffectiveDb} dB</SettingsValue>
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
          </SettingsField>
          <SettingsCallout>{t('settings.loudnessFirstPlayNote')}</SettingsCallout>
        </SettingsSubCard>
      )}
    </SettingsGroup>
  );
}
