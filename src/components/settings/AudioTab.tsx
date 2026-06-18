import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Music2, Sliders, Waves } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import Equalizer from '../Equalizer';
import SettingsSubSection from '../SettingsSubSection';
import { SettingsGroup } from './SettingsGroup';
import { SettingsToggle } from './SettingsToggle';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '../../utils/audio/loudnessPreAnalysisSlider';
import { useAudioDevicesProbe } from '../../hooks/useAudioDevicesProbe';
import { AudioOutputDeviceSection } from './audio/AudioOutputDeviceSection';
import { NormalizationBlock } from './audio/NormalizationBlock';
import { Gauge } from 'lucide-react';
import { PlaybackBehaviorBlock } from './audio/PlaybackBehaviorBlock';
import { PlaybackRateBlock } from './audio/PlaybackRateBlock';
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
          <SettingsGroup>
            <SettingsToggle
              desc={t('settings.hiResDesc')}
              ariaLabel={t('settings.hiResEnabled')}
              id="hires-enabled-toggle"
              checked={auth.enableHiRes}
              onChange={auth.setEnableHiRes}
            />
          </SettingsGroup>
        </div>
      </SettingsSubSection>

      {/* Equalizer */}
      <SettingsSubSection
        title={t('settings.eqTitle')}
        icon={<Sliders size={16} />}
      >
        <div className="settings-card">
          <SettingsGroup>
            <Equalizer />
          </SettingsGroup>
        </div>
      </SettingsSubSection>

      {/* Playback speed */}
      <SettingsSubSection
        title={t('settings.playbackRateTitle')}
        icon={<Gauge size={16} />}
      >
        <div className="settings-card">
          <SettingsGroup>
            <PlaybackRateBlock t={t} />
          </SettingsGroup>
        </div>
      </SettingsSubSection>

      {/* Replay Gain + Crossfade + Gapless */}
      <SettingsSubSection
        title={t('settings.playbackTitle')}
        icon={<Music2 size={16} />}
      >
        <div className="settings-card">
          <NormalizationBlock preAnalysisEffectiveDb={preAnalysisEffectiveDb} t={t} />
          <PlaybackBehaviorBlock t={t} />
        </div>
      </SettingsSubSection>

      <TrackPreviewsSection t={t} />
    </>
  );
}
