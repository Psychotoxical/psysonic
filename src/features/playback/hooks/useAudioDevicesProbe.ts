import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  audioCanonicalizeSelectedDevice,
  audioDefaultOutputDeviceName,
  audioListDevices,
} from '@/lib/api/audio';
import type { TFunction } from 'i18next';
import { useAuthStore } from '@/store/authStore';
import { IS_MACOS } from '@/lib/util/platform';
import { sortAudioDeviceIds } from '@/features/playback/utils/audio/audioDeviceLabels';
import { showToast } from '@/lib/dom/toast';

interface UseAudioDevicesProbeResult {
  audioDevices: string[];
  osDefaultAudioDeviceId: string | null;
  deviceSwitching: boolean;
  devicesLoading: boolean;
  setDeviceSwitching: (v: boolean) => void;
  refreshAudioDevices: (opts?: { silent?: boolean }) => void;
}

/**
 * Drive the audio-output-device picker in the audio settings tab. Calls
 * the Rust side to list devices + the current OS default, canonicalises
 * the persisted selection (filenames may have shifted between runs), and
 * re-runs whenever the backend reopens the stream
 * (`audio:device-changed` / `audio:device-reset`).
 *
 * macOS short-circuits — the audio stream is pinned to the system default
 * there, and the whole output-device category is gated out in settings.
 */
export function useAudioDevicesProbe(t: TFunction): UseAudioDevicesProbeResult {
  const [audioDevices, setAudioDevices] = useState<string[]>([]);
  const [osDefaultAudioDeviceId, setOsDefaultAudioDeviceId] = useState<string | null>(null);
  const [deviceSwitching, setDeviceSwitching] = useState(false);
  const [devicesLoading, setDevicesLoading] = useState(false);

  const refreshAudioDevices = useCallback((opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent;
    if (!silent) setDevicesLoading(true);
    const listP = audioListDevices().catch((e) => {
      console.error(e);
      showToast(t('settings.audioOutputDeviceListError'), 5000, 'error');
      return [] as string[];
    });
    const defP = audioDefaultOutputDeviceName().catch(() => null);
    Promise.all([listP, defP])
      .then(async ([devices, osDefault]) => {
        let canon: string | null = null;
        try {
          canon = await audioCanonicalizeSelectedDevice();
          if (canon) useAuthStore.getState().setAudioOutputDevice(canon);
        } catch {
          /* ignore */
        }
        const finalList = canon
          ? await audioListDevices().catch(() => devices)
          : devices;
        const defId = osDefault ?? null;
        setAudioDevices(sortAudioDeviceIds(finalList, defId));
        setOsDefaultAudioDeviceId(defId);
      })
      .finally(() => {
        if (!silent) setDevicesLoading(false);
      });
  }, [t]);

  useEffect(() => {
    if (IS_MACOS) return;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshAudioDevices();
  }, [refreshAudioDevices]);

  useEffect(() => {
    if (IS_MACOS) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    (async () => {
      for (const ev of ['audio:device-changed', 'audio:device-reset'] as const) {
        const u = await listen(ev, () => {
          if (!cancelled) refreshAudioDevices({ silent: true });
        });
        if (cancelled) {
          u();
          return;
        }
        unlisteners.push(u);
      }
    })();
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, [refreshAudioDevices]);

  return {
    audioDevices,
    osDefaultAudioDeviceId,
    deviceSwitching,
    devicesLoading,
    setDeviceSwitching,
    refreshAudioDevices,
  };
}
