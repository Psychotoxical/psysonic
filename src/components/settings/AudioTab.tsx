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

          {/* Crossfade */}
          <div className="settings-toggle-row" style={auth.gaplessEnabled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
            <div>
              <div style={{ fontWeight: 500 }}>
                {t('settings.crossfade')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {auth.gaplessEnabled ? t('settings.notWithGapless') : t('settings.crossfadeDesc')}
              </div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.crossfade')}>
              <input type="checkbox" checked={auth.crossfadeEnabled} disabled={auth.gaplessEnabled}
                onChange={e => { auth.setGaplessEnabled(false); auth.setCrossfadeEnabled(e.target.checked); }} id="crossfade-toggle" />
              <span className="toggle-track" />
            </label>
          </div>
          {auth.crossfadeEnabled && !auth.gaplessEnabled && (
            <div style={{ paddingLeft: '1rem', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <input
                type="range"
                min={0.1}
                max={10}
                step={0.1}
                value={auth.crossfadeSecs}
                onChange={e => auth.setCrossfadeSecs(parseFloat(e.target.value))}
                style={{ flex: 1, minWidth: 80, maxWidth: 200 }}
                id="crossfade-secs-slider"
              />
              <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 36 }}>
                {t('settings.crossfadeSecs', { n: auth.crossfadeSecs.toFixed(1) })}
              </span>
            </div>
          )}

          <div className="divider" />

          {/* Gapless */}
          <div className="settings-toggle-row" style={auth.crossfadeEnabled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
            <div>
              <div style={{ fontWeight: 500 }}>
                {t('settings.gapless')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {auth.crossfadeEnabled ? t('settings.notWithCrossfade') : t('settings.gaplessDesc')}
              </div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.gapless')}>
              <input type="checkbox" checked={auth.gaplessEnabled} disabled={auth.crossfadeEnabled}
                onChange={e => { auth.setCrossfadeEnabled(false); auth.setGaplessEnabled(e.target.checked); }} id="gapless-toggle" />
              <span className="toggle-track" />
            </label>
          </div>

          <div className="settings-toggle-row" style={{ marginTop: '0.75rem' }}>
            <div>
              <div style={{ fontWeight: 500 }}>
                {t('settings.preservePlayNextOrder')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t('settings.preservePlayNextOrderDesc')}
              </div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.preservePlayNextOrder')}>
              <input type="checkbox" checked={auth.preservePlayNextOrder}
                onChange={e => auth.setPreservePlayNextOrder(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
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
