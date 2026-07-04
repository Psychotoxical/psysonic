import React from 'react';
import { audioSetDevice } from '@/lib/api/audio';
import { AudioLines, RotateCcw } from 'lucide-react';
import type { TFunction } from 'i18next';
import CustomSelect from '@/ui/CustomSelect';
import SettingsSubSection from '@/features/settings/components/SettingsSubSection';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { SettingsToggle } from '@/features/settings/components/SettingsToggle';
import { useAuthStore } from '@/store/authStore';
import { useEqStore } from '@/store/eqStore';
import { buildAudioDeviceSelectOptions } from '@/features/playback/utils/audio/audioDeviceLabels';

interface Props {
  audioDevices: string[];
  osDefaultAudioDeviceId: string | null;
  deviceSwitching: boolean;
  devicesLoading: boolean;
  setDeviceSwitching: (v: boolean) => void;
  refreshAudioDevices: (opts?: { silent?: boolean }) => void;
  t: TFunction;
}

/**
 * Audio output device picker. Not rendered on macOS — the audio stream is
 * pinned to the system default there, so the whole category is gated out by
 * the caller (`AudioTab`).
 *
 * The device switch is best-effort: if `audio_set_device` rejects (e.g.
 * device disappeared) we leave the previous selection in the store.
 */
export function AudioOutputDeviceSection({
  audioDevices,
  osDefaultAudioDeviceId,
  deviceSwitching,
  devicesLoading,
  setDeviceSwitching,
  refreshAudioDevices,
  t,
}: Props) {
  const audioOutputDevice = useAuthStore(s => s.audioOutputDevice);
  const setAudioOutputDevice = useAuthStore(s => s.setAudioOutputDevice);
  const rememberEqPerDevice = useEqStore(s => s.rememberPerDevice);
  const setRememberEqPerDevice = useEqStore(s => s.setRememberPerDevice);

  return (
    <SettingsSubSection
      title={t('settings.audioOutputDevice')}
      icon={<AudioLines size={16} />}
    >
      <div className="settings-card">
        <SettingsGroup>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            {t('settings.audioOutputDeviceDesc')}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <CustomSelect
              style={{ flex: 1 }}
              value={audioOutputDevice ?? ''}
              disabled={deviceSwitching || devicesLoading}
              onChange={async (val) => {
                const device = val || null;
                setDeviceSwitching(true);
                try {
                  await audioSetDevice({ deviceName: device });
                  setAudioOutputDevice(device);
                } catch { /* device open failed — don't persist */ }
                setDeviceSwitching(false);
              }}
              options={buildAudioDeviceSelectOptions(
                audioDevices,
                t('settings.audioOutputDeviceDefault'),
                osDefaultAudioDeviceId,
                t('settings.audioOutputDeviceOsDefaultNow'),
                audioOutputDevice,
                t('settings.audioOutputDeviceNotInCurrentList'),
              )}
            />
            <button
              className="icon-btn"
              onClick={() => refreshAudioDevices()}
              disabled={devicesLoading || deviceSwitching}
              data-tooltip={t('settings.audioOutputDeviceRefresh')}
            >
              <RotateCcw size={15} className={devicesLoading ? 'spin' : ''} />
            </button>
          </div>
        </SettingsGroup>
        <SettingsGroup>
          <SettingsToggle
            label={t('settings.audioOutputDeviceRememberEq')}
            desc={t('settings.audioOutputDeviceRememberEqDesc')}
            checked={rememberEqPerDevice}
            onChange={setRememberEqPerDevice}
            searchText={t('settings.audioOutputDeviceRememberEq')}
          />
        </SettingsGroup>
      </div>
    </SettingsSubSection>
  );
}
