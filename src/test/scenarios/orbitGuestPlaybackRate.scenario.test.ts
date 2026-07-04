import { beforeEach, describe, expect, it } from 'vitest';
import { usePlaybackRateStore } from '@/features/playback/store/playbackRateStore';
import { DEFAULT_PLAYBACK_STRATEGY } from '@/features/playback/utils/audio/playbackRateHelpers';
import { registerOrbitRuntime, type OrbitSnapshot } from '@/store/orbitRuntime';
import { resetAllStores } from '@/test/helpers/storeReset';
import { invokeMock, onInvoke } from '@/test/mocks/tauri';

// Scenario: orbit guest × local playback rate. Orbit shared playback assumes a
// 1.0× wall-clock, so `syncPlaybackRate` suppresses the DSP rate at the engine
// (enabled → false) via the orbitRuntime seam's isOrbitPlaybackSyncActive(),
// WITHOUT mutating the stored prefs. With no session the local rate applies
// unchanged. Entry point is the store's syncToRust() — what the
// usePlaybackRateOrbitSync hook fires on every orbit role/phase change.

function registerSnapshot(snap: OrbitSnapshot): void {
  registerOrbitRuntime({ getSnapshot: () => snap, bulkGuard: async () => true });
}

function lastRateCall(): { enabled: boolean; speed: number } | undefined {
  const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'audio_set_playback_rate');
  return calls.length ? (calls[calls.length - 1][1] as { enabled: boolean; speed: number }) : undefined;
}

beforeEach(() => {
  resetAllStores();
  // A real local rate the user turned on (1.25×). Suppression must not touch it.
  usePlaybackRateStore.setState({
    enabled: true,
    speed: 1.25,
    strategy: DEFAULT_PLAYBACK_STRATEGY,
    pitchSemitones: 0,
  });
  onInvoke('audio_set_playback_rate', () => undefined);
});

describe('orbit guest × local playback rate', () => {
  it.each<{ role: 'guest' | 'host'; phase: 'active' | 'joining' | 'starting' }>([
    { role: 'guest', phase: 'active' },
    { role: 'guest', phase: 'joining' },
    { role: 'host', phase: 'active' },
  ])('$role in $phase session → local rate suppressed at the engine', ({ role, phase }) => {
    registerSnapshot({ role, phase, state: null });
    usePlaybackRateStore.getState().syncToRust();
    expect(lastRateCall()?.enabled).toBe(false);
    // The stored preference is untouched — suppression is engine-only.
    expect(usePlaybackRateStore.getState().enabled).toBe(true);
    expect(usePlaybackRateStore.getState().speed).toBe(1.25);
  });

  it('no session → local rate applies unchanged', () => {
    registerSnapshot({ role: null, phase: 'idle', state: null });
    usePlaybackRateStore.getState().syncToRust();
    expect(lastRateCall()?.enabled).toBe(true);
    expect(lastRateCall()?.speed).toBe(1.25);
  });

  it('leaving a session re-applies the local rate', () => {
    registerSnapshot({ role: 'guest', phase: 'active', state: null });
    usePlaybackRateStore.getState().syncToRust();
    expect(lastRateCall()?.enabled).toBe(false);

    // Orbit ends → the hook re-syncs and the local rate comes back.
    registerSnapshot({ role: null, phase: 'idle', state: null });
    usePlaybackRateStore.getState().syncToRust();
    expect(lastRateCall()?.enabled).toBe(true);
  });
});
