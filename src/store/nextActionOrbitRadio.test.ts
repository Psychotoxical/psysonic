import { beforeEach, describe, expect, it, vi } from 'vitest';

// Control points for the test.
const { inOrbit, getSimilarSongs2, getTopSongs } = vi.hoisted(() => ({
  inOrbit: { value: false },
  getSimilarSongs2: vi.fn(() => Promise.resolve([])),
  getTopSongs: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../api/subsonicArtists', () => ({ getSimilarSongs2, getTopSongs }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock('./orbitSession', () => ({ isInOrbitSession: () => inOrbit.value }));
vi.mock('./authStore', () => ({
  useAuthStore: { getState: () => ({ infiniteQueueEnabled: false }) },
}));
vi.mock('./radioSessionState', () => ({
  addRadioSessionSeen: vi.fn(),
  getCurrentRadioArtistId: () => null,
  hasRadioSessionSeen: () => false,
  isRadioFetching: () => false,
  setRadioFetching: vi.fn(),
}));
vi.mock('./infiniteQueueState', () => ({
  isInfiniteQueueFetching: () => false,
  setInfiniteQueueFetching: vi.fn(),
}));
vi.mock('./engineState', () => ({ setIsAudioPaused: vi.fn() }));
vi.mock('./skipStarRating', () => ({ applySkipStarOnManualNext: vi.fn() }));
vi.mock('../utils/library/queueTrackView', () => ({
  resolveQueueTrack: (ref: { trackId: string }) => ({
    id: ref.trackId,
    artistId: 'a1',
    artist: 'Artist',
  }),
}));
vi.mock('../utils/playback/buildInfiniteQueueCandidates', () => ({
  buildInfiniteQueueCandidates: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../utils/playback/songToTrack', () => ({ songToTrack: (s: unknown) => s }));
vi.mock('../utils/playback/playbackServer', () => ({ ensureQueueServerPinned: () => null }));
vi.mock('../utils/library/queueTrackResolver', () => ({ seedQueueResolver: vi.fn() }));
vi.mock('../utils/library/queueItemRef', () => ({ toQueueItemRefs: () => [] }));

import { runNext } from './nextAction';

function fakeGet() {
  // index 0 → next is the radioAdded ref at index 1; nothing radio ahead of it,
  // so the ≤2-remaining proactive top-up is eligible.
  const queueItems = [
    { trackId: 't0', radioAdded: true },
    { trackId: 't1', radioAdded: true },
    { trackId: 't2', radioAdded: false },
  ];
  return {
    queueItems,
    queueIndex: 0,
    repeatMode: 'off' as const,
    currentTrack: { id: 't0', artistId: 'a1', artist: 'Artist', radioAdded: true },
    playTrack: vi.fn(),
  };
}

beforeEach(() => {
  inOrbit.value = false;
  getSimilarSongs2.mockClear();
  getTopSongs.mockClear();
});

describe('runNext — radio proactive top-up Orbit lockout', () => {
  it('fires the radio top-up when not in an Orbit session', () => {
    const get = fakeGet as unknown as () => never;
    runNext(vi.fn(), get, /* manual */ false);
    expect(getSimilarSongs2).toHaveBeenCalledTimes(1);
  });

  it('skips the radio top-up while in an Orbit session', () => {
    inOrbit.value = true;
    const get = fakeGet as unknown as () => never;
    runNext(vi.fn(), get, /* manual */ false);
    expect(getSimilarSongs2).not.toHaveBeenCalled();
    expect(getTopSongs).not.toHaveBeenCalled();
  });
});
