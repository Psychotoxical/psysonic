import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Blend, Gauge, Sliders, Volume2, Waves } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { Equalizer } from '@/features/equalizer';
import SettingsSubSection from '@/features/settings/components/SettingsSubSection';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { SettingsToggle } from '@/features/settings/components/SettingsToggle';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '@/lib/audio/loudnessPreAnalysisSlider';
import { useAudioDevicesProbe } from '@/features/playback/hooks/useAudioDevicesProbe';
import { IS_MACOS } from '@/lib/util/platform';
import { AudioOutputDeviceSection } from '@/features/settings/components/audio/AudioOutputDeviceSection';
import { NormalizationBlock } from '@/features/settings/components/audio/NormalizationBlock';
import { PlaybackRateBlock } from '@/features/settings/components/audio/PlaybackRateBlock';
import { TrackTransitionsBlock } from '@/features/settings/components/audio/TrackTransitionsBlock';
import { TrackPreviewsSection } from '@/features/settings/components/audio/TrackPreviewsSection';
import { HiResCrossfadeResampleBlock } from '@/features/settings/components/audio/HiResCrossfadeResampleBlock';

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
            <HiResCrossfadeResampleBlock
              enabled={auth.enableHiRes}
              resampleHz={auth.hiResCrossfadeResampleHz}
              onResampleHzChange={auth.setHiResCrossfadeResampleHz}
              t={t}
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
