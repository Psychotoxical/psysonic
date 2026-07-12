import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitTauriEvent, onInvoke } from '@/test/mocks/tauri';
import { useEqStore, type EqSnapshot } from '@/store/eqStore';
import { useAuthStore } from '@/store/authStore';
import { setupEqDeviceSync } from '@/features/playback/store/audioListenerSetup/eqDeviceSync';

const FLAT = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

function resetEq(over: Partial<{
  gains: number[];
  enabled: boolean;
  preGain: number;
  activePreset: string | null;
  rememberPerDevice: boolean;
  byDevice: Record<string, EqSnapshot>;
}> = {}): void {
  useEqStore.setState({
    gains: [...FLAT],
    enabled: false,
    preGain: 0,
    activePreset: 'Flat',
    customPresets: [],
    rememberPerDevice: false,
    byDevice: {},
    ...over,
  });
}

function snap(gain0: number, over: Partial<EqSnapshot> = {}): EqSnapshot {
  return { gains: [gain0, 0, 0, 0, 0, 0, 0, 0, 0, 0], enabled: false, preGain: 0, activePreset: null, ...over };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Wait until startup OS-default resolution has applied (when audioOutputDevice is null). */
async function waitForOsDefaultInit(expectedGain0?: number): Promise<void> {
  await vi.waitFor(async () => {
    await flushAsync();
    if (expectedGain0 !== undefined) {
      expect(useEqStore.getState().gains[0]).toBe(expectedGain0);
    }
  });
}

describe('eqDeviceSync', () => {
  let cleanup: () => void = () => {};

  beforeEach(() => {
    resetEq();
    useAuthStore.getState().setAudioOutputDevice(null);
    onInvoke('audio_default_output_device_name', () => 'Speakers');
    onInvoke('audio_default_output_device_name_for_poll', () => 'Speakers');
    onInvoke('audio_match_stored_output_device_key', () => null);
  });

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  it('mirrors live EQ edits into the current device snapshot when enabled', async () => {
    useAuthStore.getState().setAudioOutputDevice('Speakers');
    resetEq({ rememberPerDevice: true });
    cleanup = setupEqDeviceSync();
    await flushAsync();

    useEqStore.getState().setBandGain(0, 4);

    expect(useEqStore.getState().byDevice['Speakers'].gains[0]).toBe(4);
  });

  it('does not mirror edits when the feature is off', async () => {
    useAuthStore.getState().setAudioOutputDevice('Speakers');
    resetEq({ rememberPerDevice: false });
    cleanup = setupEqDeviceSync();
    await flushAsync();

    useEqStore.getState().setBandGain(0, 4);

    expect(useEqStore.getState().byDevice).toEqual({});
  });

  it('seeds the current device snapshot when the feature is switched on', async () => {
    useAuthStore.getState().setAudioOutputDevice('Speakers');
    resetEq({ gains: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    cleanup = setupEqDeviceSync();
    await flushAsync();

    useEqStore.getState().setRememberPerDevice(true);

    expect(useEqStore.getState().byDevice['Speakers']?.gains[0]).toBe(2);
  });

  it('saves the old device and restores the new device on switch', async () => {
    useAuthStore.getState().setAudioOutputDevice('A');
    resetEq({ rememberPerDevice: true, byDevice: { B: snap(7, { enabled: true, preGain: 1 }) } });
    cleanup = setupEqDeviceSync();
    await flushAsync();

    useEqStore.getState().setBandGain(0, 3);
    expect(useEqStore.getState().byDevice['A'].gains[0]).toBe(3);

    useAuthStore.getState().setAudioOutputDevice('B');
    await flushAsync();
    expect(useEqStore.getState().gains[0]).toBe(7);
    expect(useEqStore.getState().enabled).toBe(true);

    expect(useEqStore.getState().byDevice['A'].gains[0]).toBe(3);
    expect(useEqStore.getState().byDevice['B'].gains[0]).toBe(7);
  });

  it('keeps the current EQ when the new device has no saved snapshot', async () => {
    useAuthStore.getState().setAudioOutputDevice('A');
    resetEq({ rememberPerDevice: true, gains: [5, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    cleanup = setupEqDeviceSync();
    await flushAsync();

    useAuthStore.getState().setAudioOutputDevice('NoProfile');
    await flushAsync();

    expect(useEqStore.getState().gains[0]).toBe(5);
  });

  it('applies the saved snapshot for the current device on startup', async () => {
    useAuthStore.getState().setAudioOutputDevice('A');
    resetEq({ rememberPerDevice: true, byDevice: { A: snap(9, { enabled: true, preGain: 2, activePreset: 'X' }) } });
    cleanup = setupEqDeviceSync();
    await flushAsync();

    const s = useEqStore.getState();
    expect(s.gains[0]).toBe(9);
    expect(s.enabled).toBe(true);
    expect(s.activePreset).toBe('X');
  });

  it('preset on dev1, preset on dev2, back to dev1 restores dev1 preset', async () => {
    useAuthStore.getState().setAudioOutputDevice('Device1');
    resetEq({ rememberPerDevice: true });
    cleanup = setupEqDeviceSync();
    await flushAsync();

    useEqStore.getState().applyPreset('Jazz');
    expect(useEqStore.getState().activePreset).toBe('Jazz');

    useAuthStore.getState().setAudioOutputDevice('Device2');
    await flushAsync();
    useEqStore.getState().applyPreset('Rock');
    expect(useEqStore.getState().activePreset).toBe('Rock');

    useAuthStore.getState().setAudioOutputDevice('Device1');
    await flushAsync();
    expect(useEqStore.getState().activePreset).toBe('Jazz');
  });

  it('mirrors system default into the resolved OS default device bucket', async () => {
    onInvoke('audio_default_output_device_name', () => 'Speakers');
    useAuthStore.getState().setAudioOutputDevice(null);
    resetEq({ rememberPerDevice: true });
    cleanup = setupEqDeviceSync();
    await waitForOsDefaultInit();

    useEqStore.getState().setBandGain(0, 4);

    expect(useEqStore.getState().byDevice['Speakers'].gains[0]).toBe(4);
    expect(useEqStore.getState().byDevice['__default__']).toBeUndefined();
  });

  it('restores the OS default device profile when switching back to system default', async () => {
    useAuthStore.getState().setAudioOutputDevice('A');
    resetEq({
      rememberPerDevice: true,
      byDevice: { Speakers: snap(8, { enabled: true }) },
    });
    onInvoke('audio_default_output_device_name', () => 'Speakers');
    cleanup = setupEqDeviceSync();
    await flushAsync();

    useAuthStore.getState().setAudioOutputDevice(null);
    await waitForOsDefaultInit(8);
    expect(useEqStore.getState().enabled).toBe(true);
  });

  it('falls back to the legacy Default Audio Device profile when the resolved device has no snapshot', async () => {
    onInvoke('audio_default_output_device_name', () => 'Speakers');
    useAuthStore.getState().setAudioOutputDevice(null);
    resetEq({ rememberPerDevice: true, byDevice: { 'Default Audio Device': snap(6, { enabled: true }) } });
    cleanup = setupEqDeviceSync();
    await waitForOsDefaultInit(6);
  });

  it('falls back to the legacy __default__ profile when the resolved device has no snapshot', async () => {
    onInvoke('audio_default_output_device_name', () => 'Speakers');
    useAuthStore.getState().setAudioOutputDevice(null);
    resetEq({ rememberPerDevice: true, byDevice: { __default__: snap(6, { enabled: true }) } });
    cleanup = setupEqDeviceSync();
    await waitForOsDefaultInit(6);
    expect(useEqStore.getState().enabled).toBe(true);
  });

  it('switches EQ when the OS default changes externally (audio:device-changed)', async () => {
    onInvoke('audio_default_output_device_name', () => 'Speakers');
    useAuthStore.getState().setAudioOutputDevice(null);
    resetEq({
      rememberPerDevice: true,
      byDevice: {
        Speakers: snap(3),
        Headphones: snap(9, { enabled: true }),
      },
    });
    cleanup = setupEqDeviceSync();
    await waitForOsDefaultInit(3);

    onInvoke('audio_default_output_device_name', () => 'Headphones');
    emitTauriEvent('audio:device-changed', null);
    await flushAsync();

    expect(useEqStore.getState().gains[0]).toBe(9);
    expect(useEqStore.getState().enabled).toBe(true);
  });

  it('switches EQ on audio:device-reset when following system default', async () => {
    onInvoke('audio_default_output_device_name', () => 'Speakers');
    useAuthStore.getState().setAudioOutputDevice(null);
    resetEq({
      rememberPerDevice: true,
      byDevice: { Speakers: snap(2), Headphones: snap(7) },
    });
    cleanup = setupEqDeviceSync();
    await waitForOsDefaultInit(2);

    onInvoke('audio_default_output_device_name', () => 'Headphones');
    emitTauriEvent('audio:device-reset', null);
    await flushAsync();

    expect(useEqStore.getState().gains[0]).toBe(7);
  });

  it('does not react to device events when a device is pinned', async () => {
    useAuthStore.getState().setAudioOutputDevice('A');
    resetEq({
      rememberPerDevice: true,
      gains: [5, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      byDevice: { Headphones: snap(9) },
    });
    cleanup = setupEqDeviceSync();
    await flushAsync();

    onInvoke('audio_default_output_device_name', () => 'Headphones');
    emitTauriEvent('audio:device-changed', null);
    await flushAsync();

    expect(useEqStore.getState().gains[0]).toBe(5);
  });

  it('does not apply the legacy __default__ profile to a pinned device without a snapshot', async () => {
    useAuthStore.getState().setAudioOutputDevice('A');
    resetEq({
      rememberPerDevice: true,
      gains: [5, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      byDevice: { __default__: snap(9, { enabled: true }) },
    });
    cleanup = setupEqDeviceSync();
    await flushAsync();

    expect(useEqStore.getState().gains[0]).toBe(5);
    expect(useEqStore.getState().enabled).toBe(false);
  });

  it('restores pinned device EQ when the stored key is a legacy description name', async () => {
    onInvoke('audio_match_stored_output_device_key', (args) => {
      const { candidate, storedKeys } = args as { candidate: string; storedKeys: string[] };
      if (candidate === 'Wasapi:{speakers-guid}' && storedKeys.includes('Speakers')) {
        return 'Speakers';
      }
      return null;
    });
    useAuthStore.getState().setAudioOutputDevice('Wasapi:{speakers-guid}');
    resetEq({
      rememberPerDevice: true,
      byDevice: { Speakers: snap(8, { enabled: true }) },
    });
    cleanup = setupEqDeviceSync();
    await flushAsync();

    expect(useEqStore.getState().gains[0]).toBe(8);
    expect(useEqStore.getState().enabled).toBe(true);
  });

  it('matches legacy stored keys when switching pinned devices after DeviceId upgrade', async () => {
    onInvoke('audio_match_stored_output_device_key', (args) => {
      const { candidate, storedKeys } = args as { candidate: string; storedKeys: string[] };
      if (candidate === 'Wasapi:{headphones-guid}' && storedKeys.includes('Headphones')) {
        return 'Headphones';
      }
      return null;
    });
    useAuthStore.getState().setAudioOutputDevice('Wasapi:{speakers-guid}');
    resetEq({
      rememberPerDevice: true,
      byDevice: { Headphones: snap(7, { enabled: true }) },
    });
    cleanup = setupEqDeviceSync();
    await flushAsync();

    useAuthStore.getState().setAudioOutputDevice('Wasapi:{headphones-guid}');
    await flushAsync();

    expect(useEqStore.getState().gains[0]).toBe(7);
    expect(useEqStore.getState().enabled).toBe(true);
  });

  it('does not apply a queued pinned switch after the user unpins', async () => {
    let releaseMatch: () => void = () => {};
    const matchBlocked = new Promise<string | null>((resolve) => {
      releaseMatch = () => resolve(null);
    });
    onInvoke('audio_match_stored_output_device_key', () => matchBlocked);
    onInvoke('audio_default_output_device_name', () => 'Speakers');

    useAuthStore.getState().setAudioOutputDevice('A');
    resetEq({
      rememberPerDevice: true,
      byDevice: {
        A: snap(9, { enabled: true }),
        Speakers: snap(3),
      },
    });
    cleanup = setupEqDeviceSync();
    await flushAsync();

    useAuthStore.getState().setAudioOutputDevice('Wasapi:{slow-device}');
    useAuthStore.getState().setAudioOutputDevice(null);
    releaseMatch();
    await waitForOsDefaultInit(3);
    expect(useEqStore.getState().gains[0]).toBe(3);
  });

  it('saves the outgoing device snapshot when switching pinned devices', async () => {
    useAuthStore.getState().setAudioOutputDevice('A');
    resetEq({ rememberPerDevice: true });
    cleanup = setupEqDeviceSync();
    await flushAsync();

    useEqStore.getState().setBandGain(0, 3);
    useAuthStore.getState().setAudioOutputDevice('B');

    expect(useEqStore.getState().byDevice['A'].gains[0]).toBe(3);
  });

  it('cleanup stops mirroring further edits', async () => {
    useAuthStore.getState().setAudioOutputDevice('A');
    resetEq({ rememberPerDevice: true });
    cleanup = setupEqDeviceSync();
    await flushAsync();

    cleanup();
    useEqStore.getState().setBandGain(0, 6);

    expect(useEqStore.getState().byDevice['A']).toBeUndefined();
  });
});
