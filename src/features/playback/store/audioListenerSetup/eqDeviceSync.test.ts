import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn(async () => null as unknown) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

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

describe('eqDeviceSync', () => {
  let cleanup: () => void = () => {};

  beforeEach(() => {
    invokeMock.mockClear();
    resetEq();
    useAuthStore.getState().setAudioOutputDevice(null);
  });

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  it('mirrors live EQ edits into the current device snapshot when enabled', () => {
    useAuthStore.getState().setAudioOutputDevice('Speakers');
    resetEq({ rememberPerDevice: true });
    cleanup = setupEqDeviceSync();

    useEqStore.getState().setBandGain(0, 4);

    expect(useEqStore.getState().byDevice['Speakers'].gains[0]).toBe(4);
  });

  it('does not mirror edits when the feature is off', () => {
    useAuthStore.getState().setAudioOutputDevice('Speakers');
    resetEq({ rememberPerDevice: false });
    cleanup = setupEqDeviceSync();

    useEqStore.getState().setBandGain(0, 4);

    expect(useEqStore.getState().byDevice).toEqual({});
  });

  it('seeds the current device snapshot when the feature is switched on', () => {
    useAuthStore.getState().setAudioOutputDevice('Speakers');
    resetEq({ gains: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    cleanup = setupEqDeviceSync();

    useEqStore.getState().setRememberPerDevice(true);

    expect(useEqStore.getState().byDevice['Speakers']?.gains[0]).toBe(2);
  });

  it('saves the old device and restores the new device on switch', () => {
    useAuthStore.getState().setAudioOutputDevice('A');
    resetEq({ rememberPerDevice: true, byDevice: { B: snap(7, { enabled: true, preGain: 1 }) } });
    cleanup = setupEqDeviceSync();

    // Edit on A is mirrored into A's snapshot.
    useEqStore.getState().setBandGain(0, 3);
    expect(useEqStore.getState().byDevice['A'].gains[0]).toBe(3);

    // Switching to B restores B's saved profile to the live EQ.
    useAuthStore.getState().setAudioOutputDevice('B');
    expect(useEqStore.getState().gains[0]).toBe(7);
    expect(useEqStore.getState().enabled).toBe(true);

    // A's saved snapshot is preserved (not overwritten by applying B).
    expect(useEqStore.getState().byDevice['A'].gains[0]).toBe(3);
    expect(useEqStore.getState().byDevice['B'].gains[0]).toBe(7);
  });

  it('keeps the current EQ when the new device has no saved snapshot', () => {
    useAuthStore.getState().setAudioOutputDevice('A');
    resetEq({ rememberPerDevice: true, gains: [5, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    cleanup = setupEqDeviceSync();

    useAuthStore.getState().setAudioOutputDevice('NoProfile');

    expect(useEqStore.getState().gains[0]).toBe(5);
  });

  it('applies the saved snapshot for the current device on startup', () => {
    useAuthStore.getState().setAudioOutputDevice('A');
    resetEq({ rememberPerDevice: true, byDevice: { A: snap(9, { enabled: true, preGain: 2, activePreset: 'X' }) } });
    cleanup = setupEqDeviceSync();

    const s = useEqStore.getState();
    expect(s.gains[0]).toBe(9);
    expect(s.enabled).toBe(true);
    expect(s.activePreset).toBe('X');
  });

  // Frank's exact scenario: Jazz on device 1, Rock on device 2 (neither
  // pre-seeded), then back to device 1 — must restore Jazz, not Rock.
  it('preset on dev1, preset on dev2, back to dev1 restores dev1 preset', () => {
    useAuthStore.getState().setAudioOutputDevice('Device1');
    resetEq({ rememberPerDevice: true });
    cleanup = setupEqDeviceSync();

    useEqStore.getState().applyPreset('Jazz');
    expect(useEqStore.getState().activePreset).toBe('Jazz');

    useAuthStore.getState().setAudioOutputDevice('Device2');
    useEqStore.getState().applyPreset('Rock');
    expect(useEqStore.getState().activePreset).toBe('Rock');

    useAuthStore.getState().setAudioOutputDevice('Device1');
    expect(useEqStore.getState().activePreset).toBe('Jazz');
  });

  it('mirrors the system default (null device) into the __default__ bucket', () => {
    useAuthStore.getState().setAudioOutputDevice(null);
    resetEq({ rememberPerDevice: true });
    cleanup = setupEqDeviceSync();

    useEqStore.getState().setBandGain(0, 4);

    expect(useEqStore.getState().byDevice['__default__'].gains[0]).toBe(4);
  });

  it('restores the __default__ profile when the device resets to null (unplug / audio:device-reset)', () => {
    // The audio:device-reset event sets audioOutputDevice = null; the sync
    // reacts to that store change like any other device switch.
    useAuthStore.getState().setAudioOutputDevice('A');
    resetEq({ rememberPerDevice: true, byDevice: { __default__: snap(8, { enabled: true }) } });
    cleanup = setupEqDeviceSync();

    useAuthStore.getState().setAudioOutputDevice(null);

    expect(useEqStore.getState().gains[0]).toBe(8);
    expect(useEqStore.getState().enabled).toBe(true);
  });

  it('cleanup stops mirroring further edits', () => {
    useAuthStore.getState().setAudioOutputDevice('A');
    resetEq({ rememberPerDevice: true });
    cleanup = setupEqDeviceSync();

    cleanup();
    useEqStore.getState().setBandGain(0, 6);

    expect(useEqStore.getState().byDevice['A']).toBeUndefined();
  });
});
