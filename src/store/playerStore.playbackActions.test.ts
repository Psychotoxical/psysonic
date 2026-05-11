/**
 * Playback-action characterization for `playerStore` (Phase F1 / PR 2b).
 *
 * Covers transport actions — pause / resume / togglePlay / seek / next /
 * previous / toggleRepeat — and asserts that a failing Tauri invoke
 * produces controlled error state, not partial mutation. Audio event
 * handlers live in `playerStore.events.test.ts`.
 *
 * Heavy module-level mocking: `subsonic.ts` (server APIs) and `lastfm.ts`
 * (scrobble + loved lookups) are mocked to no-ops so navigation-style
 * `playTrack` calls (from `next` / `previous`) don't try to hit a real
 * server. The store's own action bodies still run for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/subsonic', async () => {
  const actual = await vi.importActual<typeof import('@/api/subsonic')>('@/api/subsonic');
  return {
    ...actual,
    savePlayQueue: vi.fn(async () => undefined),
    getPlayQueue: vi.fn(async () => ({ songs: [], current: undefined, position: 0 })),
    buildStreamUrl: vi.fn((id: string) => `https://mock/stream/${id}`),
    buildCoverArtUrl: vi.fn((id: string) => `https://mock/cover/${id}`),
    getSong: vi.fn(async () => null),
    getRandomSongs: vi.fn(async () => []),
    getSimilarSongs2: vi.fn(async () => []),
    getTopSongs: vi.fn(async () => []),
    getAlbumInfo2: vi.fn(async () => null),
    reportNowPlaying: vi.fn(async () => undefined),
    scrobbleSong: vi.fn(async () => undefined),
    setRating: vi.fn(async () => undefined),
  };
});

vi.mock('@/api/lastfm', () => ({
  lastfmScrobble: vi.fn(async () => undefined),
  lastfmUpdateNowPlaying: vi.fn(async () => undefined),
  lastfmLoveTrack: vi.fn(async () => undefined),
  lastfmUnloveTrack: vi.fn(async () => undefined),
  lastfmGetTrackLoved: vi.fn(async () => false),
  lastfmGetAllLovedTracks: vi.fn(async () => []),
}));

vi.mock('@/utils/orbitBulkGuard', () => ({
  orbitBulkGuard: vi.fn(async () => true),
}));

import { usePlayerStore } from './playerStore';
import { useAuthStore } from './authStore';
import { onInvoke, invokeMock } from '@/test/mocks/tauri';
import { resetPlayerStore, resetAuthStore } from '@/test/helpers/storeReset';
import { makeTrack, makeTracks } from '@/test/helpers/factories';

function stubPlaybackInvokes(): void {
  onInvoke('audio_play', () => undefined);
  onInvoke('audio_pause', () => undefined);
  onInvoke('audio_resume', () => undefined);
  onInvoke('audio_stop', () => undefined);
  onInvoke('audio_seek', () => undefined);
  onInvoke('audio_get_state', () => ({ playing: false }));
  onInvoke('audio_update_replay_gain', () => undefined);
  onInvoke('audio_set_normalization', () => undefined);
  onInvoke('discord_update_presence', () => undefined);
  onInvoke('frontend_debug_log', () => undefined);
}

beforeEach(() => {
  // Fake timers across the file so module-scoped locks (`togglePlayLock`,
  // `seekDebounce`) don't bleed between tests. afterEach drains pending
  // timer callbacks so each next test sees a clean slate.
  vi.useFakeTimers();
  resetPlayerStore();
  resetAuthStore();
  stubPlaybackInvokes();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('pause', () => {
  it('invokes audio_pause and clears isPlaying', () => {
    usePlayerStore.setState({ isPlaying: true, currentTrack: makeTrack() });
    usePlayerStore.getState().pause();
    expect(invokeMock).toHaveBeenCalledWith('audio_pause');
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it('still clears isPlaying when the engine invoke rejects (controlled error)', () => {
    onInvoke('audio_pause', () => { throw new Error('engine gone'); });
    usePlayerStore.setState({ isPlaying: true, currentTrack: makeTrack() });
    usePlayerStore.getState().pause();
    // `invoke('audio_pause').catch(...)` is fire-and-forget — state mutation
    // happens regardless of whether the engine call succeeds.
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it('clears any pending scheduled pause / resume timers', () => {
    usePlayerStore.setState({
      isPlaying: true,
      currentTrack: makeTrack(),
      scheduledPauseAtMs: Date.now() + 60_000,
      scheduledPauseStartMs: Date.now(),
      scheduledResumeAtMs: Date.now() + 120_000,
      scheduledResumeStartMs: Date.now(),
    });
    usePlayerStore.getState().pause();
    const s = usePlayerStore.getState();
    expect(s.scheduledPauseAtMs).toBeNull();
    expect(s.scheduledPauseStartMs).toBeNull();
    expect(s.scheduledResumeAtMs).toBeNull();
    expect(s.scheduledResumeStartMs).toBeNull();
  });
});

describe('resume — warm path (engine has the track loaded, just paused)', () => {
  it('invokes audio_resume and sets isPlaying', () => {
    // Set up a "warm" state: pause was called previously so isAudioPaused=true.
    usePlayerStore.setState({ currentTrack: makeTrack(), isPlaying: true });
    usePlayerStore.getState().pause();
    invokeMock.mockClear();

    usePlayerStore.getState().resume();
    expect(invokeMock).toHaveBeenCalledWith('audio_resume');
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it('returns without invoking when there is no current track', () => {
    usePlayerStore.setState({ currentTrack: null });
    usePlayerStore.getState().resume();
    expect(invokeMock).not.toHaveBeenCalledWith('audio_resume');
  });
});

describe('togglePlay', () => {
  it('calls pause when isPlaying is true', () => {
    usePlayerStore.setState({ isPlaying: true, currentTrack: makeTrack() });
    usePlayerStore.getState().togglePlay();
    expect(invokeMock).toHaveBeenCalledWith('audio_pause');
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it('calls resume (warm path) when isPlaying is false', () => {
    // Bring the engine into the "paused-but-loaded" state first.
    usePlayerStore.setState({ isPlaying: true, currentTrack: makeTrack() });
    usePlayerStore.getState().pause();
    invokeMock.mockClear();

    usePlayerStore.getState().togglePlay();
    expect(invokeMock).toHaveBeenCalledWith('audio_resume');
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });
});

describe('seek', () => {
  it('clamps to duration - 0.25 and updates optimistic progress immediately', () => {
    const track = makeTrack({ duration: 100 });
    usePlayerStore.setState({ currentTrack: track });
    usePlayerStore.getState().seek(1.0); // 100% — should clamp to 99.75
    const s = usePlayerStore.getState();
    expect(s.currentTime).toBeCloseTo(99.75, 5);
    expect(s.progress).toBeCloseTo(99.75 / 100, 5);
  });

  it('debounces 100 ms before invoking audio_seek', () => {
    const track = makeTrack({ duration: 120 });
    usePlayerStore.setState({ currentTrack: track });
    usePlayerStore.getState().seek(0.5);
    expect(invokeMock).not.toHaveBeenCalledWith('audio_seek', expect.anything());
    vi.advanceTimersByTime(100);
    expect(invokeMock).toHaveBeenCalledWith('audio_seek', expect.objectContaining({ seconds: 60 }));
  });

  it('coalesces rapid drags into a single backend seek', () => {
    const track = makeTrack({ duration: 120 });
    usePlayerStore.setState({ currentTrack: track });
    const s = usePlayerStore.getState();
    s.seek(0.25);
    s.seek(0.5);
    s.seek(0.75);
    vi.advanceTimersByTime(100);
    const seekCalls = invokeMock.mock.calls.filter(c => c[0] === 'audio_seek');
    expect(seekCalls).toHaveLength(1);
    expect(seekCalls[0]?.[1]).toEqual(expect.objectContaining({ seconds: 90 }));
  });

  it('is a no-op when there is no current track', () => {
    usePlayerStore.setState({ currentTrack: null });
    usePlayerStore.getState().seek(0.5);
    expect(usePlayerStore.getState().currentTime).toBe(0);
  });

  it('is a no-op when the current track has zero duration', () => {
    usePlayerStore.setState({ currentTrack: makeTrack({ duration: 0 }) });
    usePlayerStore.getState().seek(0.5);
    expect(usePlayerStore.getState().currentTime).toBe(0);
  });
});

describe('next', () => {
  it('advances to queue[queueIndex + 1] when one is available', () => {
    const queue = makeTracks(3);
    usePlayerStore.setState({
      queue,
      queueIndex: 0,
      currentTrack: queue[0],
    });
    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentTrack?.id).toBe(queue[1].id);
    expect(usePlayerStore.getState().queueIndex).toBe(1);
  });

  it('wraps to queue[0] when at the end with repeatMode=all', () => {
    const queue = makeTracks(3);
    usePlayerStore.setState({
      queue,
      queueIndex: 2,
      currentTrack: queue[2],
      repeatMode: 'all',
    });
    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentTrack?.id).toBe(queue[0].id);
    expect(usePlayerStore.getState().queueIndex).toBe(0);
  });

  it('stops the engine and clears playback when at the end with repeatMode=off', () => {
    // infiniteQueueEnabled and the radio fetch path are both off by default,
    // so the no-next branch falls through to `audio_stop`.
    const queue = makeTracks(2);
    usePlayerStore.setState({
      queue,
      queueIndex: 1,
      currentTrack: queue[1],
      repeatMode: 'off',
      isPlaying: true,
    });
    usePlayerStore.getState().next();
    expect(invokeMock).toHaveBeenCalledWith('audio_stop');
    const s = usePlayerStore.getState();
    expect(s.isPlaying).toBe(false);
    expect(s.currentTime).toBe(0);
    expect(s.progress).toBe(0);
  });
});

describe('previous', () => {
  it('restarts the current track when currentTime > 3 s', () => {
    const queue = makeTracks(3);
    usePlayerStore.setState({
      queue,
      queueIndex: 1,
      currentTrack: queue[1],
    });
    // The store's `currentTime` is the source for the "restart vs jump back"
    // branch. `getPlaybackProgressSnapshot` reads from the same field.
    usePlayerStore.setState({ currentTime: 10, progress: 10 / queue[1].duration });
    usePlayerStore.getState().previous();
    expect(invokeMock).toHaveBeenCalledWith('audio_seek', expect.objectContaining({ seconds: 0 }));
    expect(usePlayerStore.getState().queueIndex).toBe(1); // stayed on the same track
  });

  it('jumps to the previous track when currentTime ≤ 3 s and queueIndex > 0', () => {
    const queue = makeTracks(3);
    usePlayerStore.setState({
      queue,
      queueIndex: 2,
      currentTrack: queue[2],
      currentTime: 1.0,
    });
    usePlayerStore.getState().previous();
    expect(usePlayerStore.getState().currentTrack?.id).toBe(queue[1].id);
    expect(usePlayerStore.getState().queueIndex).toBe(1);
  });

  it('is a no-op when queueIndex is 0 and currentTime ≤ 3 s', () => {
    const queue = makeTracks(2);
    usePlayerStore.setState({
      queue,
      queueIndex: 0,
      currentTrack: queue[0],
      currentTime: 0.5,
    });
    usePlayerStore.getState().previous();
    expect(usePlayerStore.getState().queueIndex).toBe(0);
    expect(usePlayerStore.getState().currentTrack?.id).toBe(queue[0].id);
  });
});

describe('toggleRepeat', () => {
  it('cycles off → all → one → off', () => {
    expect(usePlayerStore.getState().repeatMode).toBe('off');
    usePlayerStore.getState().toggleRepeat();
    expect(usePlayerStore.getState().repeatMode).toBe('all');
    usePlayerStore.getState().toggleRepeat();
    expect(usePlayerStore.getState().repeatMode).toBe('one');
    usePlayerStore.getState().toggleRepeat();
    expect(usePlayerStore.getState().repeatMode).toBe('off');
  });
});
