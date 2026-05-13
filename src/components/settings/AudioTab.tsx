import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Music2, Play, Sliders, Waves } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { TRACK_PREVIEW_LOCATIONS } from '../../store/authStoreDefaults';
import type { TrackPreviewLocation } from '../../store/authStoreTypes';
import Equalizer from '../Equalizer';
import SettingsSubSection from '../SettingsSubSection';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '../../utils/loudnessPreAnalysisSlider';
import { useAudioDevicesProbe } from '../../hooks/useAudioDevicesProbe';
import { AudioOutputDeviceSection } from './audio/AudioOutputDeviceSection';
import { NormalizationBlock } from './audio/NormalizationBlock';
import { PlaybackBehaviorBlock } from './audio/PlaybackBehaviorBlock';

export function AudioTab() {
  const { t } = useTranslation();
  const auth = useAuthStore();
  const {
    audioDevices,
    osDefaultAudioDeviceId,
    deviceSwitching,
    devicesLoading,
    setDeviceSwitching,
    refreshAudioDevices,
  } = useAudioDevicesProbe(t);

  const preAnalysisEffectiveDb = useMemo(
    () => effectiveLoudnessPreAnalysisAttenuationDb(
      auth.loudnessPreAnalysisAttenuationDb,
      auth.loudnessTargetLufs,
    ),
    [auth.loudnessPreAnalysisAttenuationDb, auth.loudnessTargetLufs],
  );

  return (
    <>
      <AudioOutputDeviceSection
        audioDevices={audioDevices}
        osDefaultAudioDeviceId={osDefaultAudioDeviceId}
        deviceSwitching={deviceSwitching}
        devicesLoading={devicesLoading}
        setDeviceSwitching={setDeviceSwitching}
        refreshAudioDevices={refreshAudioDevices}
        t={t}
      />

      {/* Native Hi-Res Playback */}
      <SettingsSubSection
        title={t('settings.hiResTitle')}
        icon={<Waves size={16} />}
      >
        <div className="settings-card">
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.hiResEnabled')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.hiResDesc')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.hiResEnabled')}>
              <input
                type="checkbox"
                checked={auth.enableHiRes}
                onChange={e => auth.setEnableHiRes(e.target.checked)}
                id="hires-enabled-toggle"
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
      </SettingsSubSection>

      {/* Equalizer */}
      <SettingsSubSection
        title={t('settings.eqTitle')}
        icon={<Sliders size={16} />}
      >
        <div className="settings-card">
          <Equalizer />
        </div>
      </SettingsSubSection>

      {/* Replay Gain + Crossfade + Gapless */}
      <SettingsSubSection
        title={t('settings.playbackTitle')}
        icon={<Music2 size={16} />}
      >
        <div className="settings-card">
          <NormalizationBlock preAnalysisEffectiveDb={preAnalysisEffectiveDb} t={t} />

          <div className="divider" />

          <PlaybackBehaviorBlock t={t} />
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.trackPreviewsTitle')}
        icon={<Play size={16} />}
      >
        <div className="settings-card">
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>
                {t('settings.trackPreviewsToggle')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t('settings.trackPreviewsDesc')}
              </div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.trackPreviewsToggle')}>
              <input type="checkbox" checked={auth.trackPreviewsEnabled}
                onChange={e => auth.setTrackPreviewsEnabled(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>

          {auth.trackPreviewsEnabled && (
            <>
              <div className="divider" />
              <div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>
                  {t('settings.trackPreviewLocationsTitle')}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                  {t('settings.trackPreviewLocationsDesc')}
                </div>
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}>
                  {TRACK_PREVIEW_LOCATIONS.map((loc: TrackPreviewLocation) => (
                    <div key={loc} className="settings-toggle-row" style={{ padding: '6px var(--space-3)' }}>
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                        {t(`settings.trackPreviewLocation_${loc}`)}
                      </div>
                      <label className="toggle-switch" aria-label={t(`settings.trackPreviewLocation_${loc}`)}>
                        <input type="checkbox" checked={auth.trackPreviewLocations[loc]}
                          onChange={e => auth.setTrackPreviewLocation(loc, e.target.checked)} />
                        <span className="toggle-track" />
                      </label>
                    </div>
                  ))}
                </div>
              </div>

              <div className="divider" />
              <div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>
                  {t('settings.trackPreviewStart')}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                  {t('settings.trackPreviewStartDesc')}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <input
                    type="range"
                    min={0}
                    max={0.9}
                    step={0.01}
                    value={auth.trackPreviewStartRatio}
                    onChange={e => auth.setTrackPreviewStartRatio(parseFloat(e.target.value))}
                    style={{ flex: 1, minWidth: 80, maxWidth: 240 }}
                    aria-label={t('settings.trackPreviewStart')}
                  />
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 44 }}>
                    {Math.round(auth.trackPreviewStartRatio * 100)}%
                  </span>
                </div>
              </div>

              <div className="divider" />
              <div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>
                  {t('settings.trackPreviewDuration')}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                  {t('settings.trackPreviewDurationDesc')}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <input
                    type="range"
                    min={5}
                    max={60}
                    step={1}
                    value={auth.trackPreviewDurationSec}
                    onChange={e => auth.setTrackPreviewDurationSec(parseInt(e.target.value, 10))}
                    style={{ flex: 1, minWidth: 80, maxWidth: 240 }}
                    aria-label={t('settings.trackPreviewDuration')}
                  />
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 44 }}>
                    {t('settings.trackPreviewDurationSecs', { n: auth.trackPreviewDurationSec })}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </SettingsSubSection>
    </>
  );
}
