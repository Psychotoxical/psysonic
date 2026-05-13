import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Music2, Sliders, Waves } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import Equalizer from '../Equalizer';
import SettingsSubSection from '../SettingsSubSection';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '../../utils/loudnessPreAnalysisSlider';
import { useAudioDevicesProbe } from '../../hooks/useAudioDevicesProbe';
import { AudioOutputDeviceSection } from './audio/AudioOutputDeviceSection';
import { NormalizationBlock } from './audio/NormalizationBlock';
import { PlaybackBehaviorBlock } from './audio/PlaybackBehaviorBlock';
import { TrackPreviewsSection } from './audio/TrackPreviewsSection';

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

      <TrackPreviewsSection t={t} />
    </>
  );
}
