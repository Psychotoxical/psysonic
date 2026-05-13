import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AudioLines, RotateCcw } from 'lucide-react';
import type { TFunction } from 'i18next';
import CustomSelect from '../../CustomSelect';
import SettingsSubSection from '../../SettingsSubSection';
import { useAuthStore } from '../../../store/authStore';
import { IS_MACOS } from '../../../utils/platform';
import { buildAudioDeviceSelectOptions } from '../../../utils/audioDeviceLabels';

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
 * Audio output device picker. macOS is hard-pinned to the system default,
 * so the picker collapses to a notice on that platform.
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

  return (
    <SettingsSubSection
      title={t('settings.audioOutputDevice')}
      icon={<AudioLines size={16} />}
    >
      <div className="settings-card">
        {IS_MACOS ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
            {t('settings.audioOutputDeviceMacNotice')}
          </div>
        ) : (
          <>
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
                    await invoke('audio_set_device', { deviceName: device });
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
          </>
        )}
      </div>
    </SettingsSubSection>
  );
}
