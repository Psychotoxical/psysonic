import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Blend, Gauge, Sliders, Volume2, Waves } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import Equalizer from '../Equalizer';
import SettingsSubSection from '../SettingsSubSection';
import { SettingsGroup } from './SettingsGroup';
import { SettingsToggle } from './SettingsToggle';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '../../utils/audio/loudnessPreAnalysisSlider';
import { useAudioDevicesProbe } from '../../hooks/useAudioDevicesProbe';
import { IS_MACOS } from '../../utils/platform';
import { AudioOutputDeviceSection } from './audio/AudioOutputDeviceSection';
import { NormalizationBlock } from './audio/NormalizationBlock';
import { PlaybackRateBlock } from './audio/PlaybackRateBlock';
import { TrackTransitionsBlock } from './audio/TrackTransitionsBlock';
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
      {/* Output-device picker is hidden on macOS — the stream is pinned to the
          system default there, so the whole category is gated out. */}
      {!IS_MACOS && (
        <AudioOutputDeviceSection
          audioDevices={audioDevices}
          osDefaultAudioDeviceId={osDefaultAudioDeviceId}
          deviceSwitching={deviceSwitching}
          devicesLoading={devicesLoading}
          setDeviceSwitching={setDeviceSwitching}
          refreshAudioDevices={refreshAudioDevices}
          t={t}
        />
      )}

      {/* Normalization — loudness levelling (own category) */}
      <SettingsSubSection
        title={t('settings.normalization')}
        description={t('settings.normalizationDesc')}
        icon={<Volume2 size={16} />}
      >
        <div className="settings-card">
          <NormalizationBlock preAnalysisEffectiveDb={preAnalysisEffectiveDb} t={t} />
        </div>
      </SettingsSubSection>

      {/* Track transitions — crossfade / gapless / AutoDJ (own category) */}
      <SettingsSubSection
        title={t('settings.transitionsTitle')}
        description={t('settings.transitionsDesc')}
        icon={<Blend size={16} />}
      >
        <div className="settings-card">
          <TrackTransitionsBlock t={t} />
        </div>
      </SettingsSubSection>

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

      <TrackPreviewsSection t={t} />
    </>
  );
}
