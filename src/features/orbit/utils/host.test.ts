import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeInitialOrbitState,
  ORBIT_DEFAULT_SETTINGS,
  type OrbitSettings,
  type OrbitState,
} from '@/features/orbit/api/orbit';

const { writeOrbitState } = vi.hoisted(() => ({ writeOrbitState: vi.fn(() => Promise.resolve()) }));
const { orbitStore } = vi.hoisted(() => ({
  orbitStore: {
    role: 'host' as 'host' | 'guest' | null,
    state: null as OrbitState | null,
    sessionPlaylistId: 'session-pl' as string | null,
    setState: vi.fn(),
  },
}));

vi.mock('@/features/orbit/utils/remote', () => ({
  writeOrbitState,
  writeOrbitHeartbeat: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/features/orbit/store/orbitStore', () => ({ useOrbitStore: { getState: () => orbitStore } }));
vi.mock('@/store/authStore', () => ({ useAuthStore: { getState: () => ({}) } }));
vi.mock('@/features/playback/store/playerStore', () => ({ usePlayerStore: { getState: () => ({ enqueue: vi.fn() }) } }));
vi.mock('@/lib/api/subsonicPlaylists', () => ({ createPlaylist: vi.fn(), deletePlaylist: vi.fn() }));
vi.mock('@/lib/api/subsonicLibrary', () => ({ getSong: vi.fn() }));
vi.mock('@/lib/media/songToTrack', () => ({ songToTrack: vi.fn() }));

import { updateOrbitSettings } from '@/features/orbit/utils/host';

function hostStateWith(settings: OrbitSettings | undefined): OrbitState {
  const base = makeInitialOrbitState({ sid: 'aaaa1111', host: 'host', name: 'sesh' });
  return { ...base, settings: settings as OrbitSettings };
}

/** The settings object that updateOrbitSettings persisted on its last call. */
function writtenSettings(): OrbitSettings {
  const calls = writeOrbitState.mock.calls as unknown as Array<[string, OrbitState]>;
  const lastCall = calls[calls.length - 1];
  return lastCall[1].settings as OrbitSettings;
}

beforeEach(() => {
  writeOrbitState.mockClear();
  orbitStore.setState.mockClear();
  orbitStore.role = 'host';
  orbitStore.sessionPlaylistId = 'session-pl';
});

describe('updateOrbitSettings', () => {
  it('does not silently flip autoApprove on a legacy settings-less session', async () => {
    orbitStore.state = hostStateWith(undefined);
    await updateOrbitSettings({ autoShuffle: false });

    const settings = writtenSettings();
    // The patch only touched autoShuffle…
    expect(settings.autoShuffle).toBe(false);
    // …autoApprove must come from the canonical default (false), not flip true.
    expect(settings.autoApprove).toBe(ORBIT_DEFAULT_SETTINGS.autoApprove);
    expect(settings.autoApprove).toBe(false);
    expect(settings.shuffleIntervalMin).toBe(ORBIT_DEFAULT_SETTINGS.shuffleIntervalMin);
  });

  it('preserves existing settings when patching one field', async () => {
    orbitStore.state = hostStateWith({ autoApprove: true, autoShuffle: true, shuffleIntervalMin: 30 });
    await updateOrbitSettings({ autoShuffle: false });

    const settings = writtenSettings();
    expect(settings.autoApprove).toBe(true);
    expect(settings.autoShuffle).toBe(false);
    expect(settings.shuffleIntervalMin).toBe(30);
  });

  it('is a no-op when not hosting', async () => {
    orbitStore.role = 'guest';
    orbitStore.state = hostStateWith(undefined);
    await updateOrbitSettings({ autoShuffle: false });
    expect(writeOrbitState).not.toHaveBeenCalled();
  });
});
