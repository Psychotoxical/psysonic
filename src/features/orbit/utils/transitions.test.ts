import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrbitTransitionSettings } from '@/features/orbit/api/orbit';

const { store, setState } = vi.hoisted(() => {
  const store = {
    state: {
      crossfadeEnabled: false,
      crossfadeSecs: 3,
      crossfadeTrimSilence: false,
      autodjSmoothSkip: true,
      gaplessEnabled: false,
      autodjOverlapCapMode: 'auto',
      autodjOverlapCapSec: 15,
    } as Record<string, unknown>,
  };
  const setState = vi.fn((patch: Record<string, unknown>) => {
    store.state = { ...store.state, ...patch };
  });
  return { store, setState };
});

vi.mock('@/store/authStore', () => ({
  useAuthStore: { getState: () => store.state, setState },
}));

import {
  applyOrbitTransitionSettings,
  hasGuestTransitionsSnapshot,
  readOrbitTransitionSettings,
  restoreGuestTransitions,
  saveGuestTransitionsOnce,
} from '@/features/orbit/utils/transitions';

const GUEST_OWN: OrbitTransitionSettings = {
  crossfadeEnabled: false,
  crossfadeSecs: 3,
  crossfadeTrimSilence: false,
  autodjSmoothSkip: true,
  gaplessEnabled: false,
  autodjOverlapCapMode: 'auto',
  autodjOverlapCapSec: 15,
};
const HOST: OrbitTransitionSettings = {
  crossfadeEnabled: true,
  crossfadeSecs: 8,
  crossfadeTrimSilence: true,
  autodjSmoothSkip: false,
  gaplessEnabled: false,
  autodjOverlapCapMode: 'limit',
  autodjOverlapCapSec: 20,
};

beforeEach(() => {
  restoreGuestTransitions(); // clear any leftover snapshot from a prior test
  store.state = { ...GUEST_OWN };
  setState.mockClear();
});

describe('read/apply transition settings', () => {
  it('reads the transition fields from the store', () => {
    expect(readOrbitTransitionSettings()).toEqual(GUEST_OWN);
  });

  it('applies a set and is a no-op when already in sync', () => {
    applyOrbitTransitionSettings(HOST);
    expect(setState).toHaveBeenCalledTimes(1);
    expect(readOrbitTransitionSettings()).toEqual(HOST);

    // Same values again → must not churn setState (would re-fire audio sync).
    applyOrbitTransitionSettings(HOST);
    expect(setState).toHaveBeenCalledTimes(1);
  });
});

describe('guest snapshot save/restore', () => {
  it('snapshots the user own settings, adopts the host, then restores on leave', () => {
    saveGuestTransitionsOnce();
    expect(hasGuestTransitionsSnapshot()).toBe(true);

    applyOrbitTransitionSettings(HOST);
    expect(readOrbitTransitionSettings()).toEqual(HOST);

    restoreGuestTransitions();
    expect(readOrbitTransitionSettings()).toEqual(GUEST_OWN);
    expect(hasGuestTransitionsSnapshot()).toBe(false);
  });

  it('save is idempotent — a second save never captures host-applied values', () => {
    saveGuestTransitionsOnce();      // snapshots the user's own
    applyOrbitTransitionSettings(HOST);
    saveGuestTransitionsOnce();      // no-op: snapshot already held
    restoreGuestTransitions();
    expect(readOrbitTransitionSettings()).toEqual(GUEST_OWN);
  });

  it('restore is a no-op when nothing was saved', () => {
    store.state = { ...HOST };
    restoreGuestTransitions();
    expect(readOrbitTransitionSettings()).toEqual(HOST);
  });
});
