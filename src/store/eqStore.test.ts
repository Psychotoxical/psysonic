import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn(async () => null as unknown) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { useEqStore } from './eqStore';

const FLAT = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

function resetEq(): void {
  useEqStore.setState({
    gains: [...FLAT],
    enabled: false,
    preGain: 0,
    activePreset: 'Flat',
    customPresets: [],
    rememberPerDevice: false,
    byDevice: {},
  });
}

describe('eqStore per-device snapshots', () => {
  beforeEach(() => {
    invokeMock.mockClear();
    resetEq();
  });

  it('defaults rememberPerDevice off and byDevice empty', () => {
    const s = useEqStore.getState();
    expect(s.rememberPerDevice).toBe(false);
    expect(s.byDevice).toEqual({});
  });

  it('saveSnapshotFor captures the current live EQ under the given key', () => {
    useEqStore.setState({ gains: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0], enabled: true, preGain: -2, activePreset: null });
    useEqStore.getState().saveSnapshotFor('dev-a');
    expect(useEqStore.getState().byDevice['dev-a']).toEqual({
      gains: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      enabled: true,
      preGain: -2,
      activePreset: null,
    });
  });

  it('saveSnapshotFor stores an independent copy of the gains', () => {
    useEqStore.getState().saveSnapshotFor('dev-a');
    useEqStore.getState().setBandGain(0, 5);
    expect(useEqStore.getState().byDevice['dev-a'].gains[0]).toBe(0);
  });

  it('applySnapshot sets the live EQ and pushes it to Rust', () => {
    useEqStore.getState().applySnapshot({
      gains: [6, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      enabled: true,
      preGain: 3,
      activePreset: 'Custom',
    });
    const s = useEqStore.getState();
    expect(s.gains[0]).toBe(6);
    expect(s.enabled).toBe(true);
    expect(s.preGain).toBe(3);
    expect(s.activePreset).toBe('Custom');
    expect(invokeMock).toHaveBeenCalledWith('audio_set_eq', {
      gains: [6, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      enabled: true,
      preGain: 3,
    });
  });

  it('applySnapshot clamps out-of-range values', () => {
    useEqStore.getState().applySnapshot({
      gains: [99, -99, 0, 0, 0, 0, 0, 0, 0, 0],
      enabled: false,
      preGain: 50,
      activePreset: null,
    });
    const s = useEqStore.getState();
    expect(s.gains[0]).toBe(12);
    expect(s.gains[1]).toBe(-12);
    expect(s.preGain).toBe(6);
  });

  it('setRememberPerDevice toggles the flag', () => {
    useEqStore.getState().setRememberPerDevice(true);
    expect(useEqStore.getState().rememberPerDevice).toBe(true);
  });
});
