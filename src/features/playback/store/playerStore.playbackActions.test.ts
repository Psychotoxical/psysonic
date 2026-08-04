/**
 * Playback-action characterization for `playerStore` (Phase F1 / PR 2b).
 *
 * Covers transport actions — pause / resume / togglePlay / seek / next /
 * previous / toggleRepeat — and asserts that a failing Tauri invoke
 * produces controlled error state, not partial mutation. Audio event
 * handlers live in `playerStore.events.test.ts`.
 *
 * Heavy module-level mocking: `subsonic.ts` (server APIs) and the music-network
 * runtime (scrobble + loved lookups) are mocked to no-ops so navigation-style
 * `playTrack` calls (from `next` / `previous`) don't try to hit a real
 * server. The store's own action bodies still run for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const orbitMocks = vi.hoisted(() => ({
  role: null as 'host' | null,
  allowsTrackServer: vi.fn((_serverId?: string) => true),
  showToast: vi.fn(),
}));

const playbackMocks = vi.hoisted(() => ({
  refreshLoudnessForTrack: vi.fn(async () => undefined),
}));

vi.mock('@/features/playback/store/loudnessRefresh', () => ({
  refreshLoudnessForTrack: playbackMocks.refreshLoudnessForTrack,
}));

vi.mock('@/lib/api/subsonic', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/subsonic')>('@/lib/api/subsonic');
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

vi.mock('@/music-network', () => {
  const runtime = {
    getEnrichmentPrimaryId: vi.fn(() => null),
    dispatchScrobble: vi.fn(async () => undefined),
    dispatchNowPlaying: vi.fn(async () => undefined),
    isTrackLoved: vi.fn(async () => false),
    setTrackLoved: vi.fn(async () => undefined),
    syncLovedTracks: vi.fn(async () => ({})),
  };
  return {
    getMusicNetworkRuntime: () => runtime,
    getMusicNetworkRuntimeOrNull: () => runtime,
  };
});

vi.mock('@/store/orbitRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/store/orbitRuntime')>()),
  orbitBulkGuard: vi.fn(async () => true),
  orbitAllowsTrackServer: orbitMocks.allowsTrackServer,
  orbitSnapshot: () => ({
    role: orbitMocks.role,
    phase: orbitMocks.role ? 'active' : 'idle',
    state: null,
    serverId: orbitMocks.role ? 'srv-a' : null,
  }),
}));
vi.mock('@/lib/dom/toast', () => ({ showToast: orbitMocks.showToast }));

import { usePlayerStore } from '@/features/playback/store/playerStore';
import { onInvoke, invokeMock } from '@/test/mocks/tauri';
import { resetPlayerStore, resetAuthStore } from '@/test/helpers/storeReset';
import { makeServer, makeTrack, makeTracks, seedQueue } from '@/test/helpers/factories';
import { useAuthStore } from '@/store/authStore';
import { usePlaybackAlternativeStore } from '@/features/playback/store/playbackAlternativeStore';

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
  onInvoke('library_resolve_entity_sources', () => []);
}

beforeEach(() => {
  // Fake timers across the file so module-scoped locks (`togglePlayLock`,
  // `seekDebounce`) don't bleed between tests. afterEach drains pending
  // timer callbacks so each next test sees a clean slate.
  vi.useFakeTimers();
  resetPlayerStore();
  resetAuthStore();
  orbitMocks.role = null;
  orbitMocks.allowsTrackServer.mockReset();
  orbitMocks.allowsTrackServer.mockReturnValue(true);
  orbitMocks.showToast.mockReset();
  playbackMocks.refreshLoudnessForTrack.mockClear();
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
    seedQueue(queue, { index: 0, currentTrack: queue[0] });
    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentTrack?.id).toBe(queue[1].id);
    expect(usePlayerStore.getState().queueIndex).toBe(1);
  });

  it('wraps to queue[0] when at the end with repeatMode=all', () => {
    const queue = makeTracks(3);
    seedQueue(queue, { index: 2, currentTrack: queue[2] });
    usePlayerStore.setState({ repeatMode: 'all' });
    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentTrack?.id).toBe(queue[0].id);
    expect(usePlayerStore.getState().queueIndex).toBe(0);
  });

  it('stops the engine and clears playback when at the end with repeatMode=off', () => {
    // infiniteQueueEnabled and the radio fetch path are both off by default,
    // so the no-next branch falls through to `audio_stop`.
    const queue = makeTracks(2);
    seedQueue(queue, { index: 1, currentTrack: queue[1] });
    usePlayerStore.setState({ repeatMode: 'off', isPlaying: true });
    usePlayerStore.getState().next();
    expect(invokeMock).toHaveBeenCalledWith('audio_stop');
    const s = usePlayerStore.getState();
    expect(s.isPlaying).toBe(false);
    expect(s.currentTime).toBe(0);
    expect(s.progress).toBe(0);
  });
});

describe('mixed-server play selection', () => {
  it('jumps to the matching owner when raw track ids collide', async () => {
    const serverA = makeServer({ id: 'srv-a', url: 'https://a.test' });
    const serverB = makeServer({ id: 'srv-b', url: 'https://b.test' });
    useAuthStore.setState({ servers: [serverA, serverB], activeServerId: serverA.id });
    const a = makeTrack({ id: 'shared', serverId: serverA.id });
    const b = makeTrack({ id: 'shared', serverId: serverB.id });
    seedQueue([a, b], { index: 0, currentTrack: a });

    usePlayerStore.getState().playTrack(b);
    await vi.runAllTimersAsync();

    const state = usePlayerStore.getState();
    expect(state.queueIndex).toBe(1);
    expect(state.currentTrack).toEqual(expect.objectContaining({
      id: 'shared',
      serverId: serverB.id,
    }));
  });

  it('waits for audio_play before refreshing initial loudness', async () => {
    const server = makeServer({ id: 'srv-a', url: 'https://a.test' });
    useAuthStore.setState({ servers: [server], activeServerId: server.id });
    const track = makeTrack({ id: 'track-1', serverId: server.id });
    seedQueue([track], { index: 0, currentTrack: track, serverId: server.id });
    let resolveAudioPlay: (() => void) | undefined;
    onInvoke('audio_play', () => new Promise<void>((resolve) => {
      resolveAudioPlay = resolve;
    }));

    usePlayerStore.getState().playTrack(track);
    for (let i = 0; i < 10 && !resolveAudioPlay; i++) await Promise.resolve();

    expect(resolveAudioPlay).toBeTypeOf('function');
    expect(playbackMocks.refreshLoudnessForTrack).not.toHaveBeenCalled();

    resolveAudioPlay?.();
    await vi.runAllTimersAsync();

    expect(playbackMocks.refreshLoudnessForTrack).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: track.id }),
      { syncPlayingEngine: false },
    );
  });
});

describe('audio_play failure', () => {
  it('auto-skips only after alternative lookup finds no source', async () => {
    const server = makeServer({ id: 'srv-a', url: 'https://a.test' });
    useAuthStore.setState({
      servers: [server],
      activeServerId: server.id,
      libraryBrowseServerIds: [server.id],
    });
    const queue = makeTracks(2, index => ({
      id: `track-${index}`,
      serverId: server.id,
    }));
    seedQueue(queue, { index: 0, currentTrack: queue[0], serverId: server.id });
    const next = vi.fn();
    usePlayerStore.setState({ next });
    onInvoke('audio_play', () => { throw new Error('engine rejected source'); });

    usePlayerStore.getState().playTrack(queue[0], undefined, true, false, 0);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    const player = usePlayerStore.getState();
    expect(next).toHaveBeenCalledWith(false);
    expect(player.queueIndex).toBe(0);
    expect(player.currentTrack?.id).toBe('track-0');
    expect(usePlaybackAlternativeStore.getState().failure).toEqual(expect.objectContaining({
      queueIndex: 0,
      expectedRef: { serverId: 'a.test', trackId: 'track-0' },
      detail: 'Error: engine rejected source',
    }));
  });
});

describe('Orbit host server ownership', () => {
  it('reports a blocked cross-server play instead of failing silently', () => {
    orbitMocks.role = 'host';
    orbitMocks.allowsTrackServer.mockReturnValue(false);
    const foreign = makeTrack({ id: 'foreign', serverId: 'srv-b' });

    usePlayerStore.getState().playTrack(foreign, [foreign]);

    expect(invokeMock).not.toHaveBeenCalledWith('audio_play', expect.anything());
    expect(orbitMocks.showToast).toHaveBeenCalledWith(expect.any(String), 4000, 'error');
  });
});

describe('previous', () => {
  it('restarts the current track when currentTime > 3 s', () => {
    const queue = makeTracks(3);
    seedQueue(queue, { index: 1, currentTrack: queue[1] });
    // The store's `currentTime` is the source for the "restart vs jump back"
    // branch. `getPlaybackProgressSnapshot` reads from the same field.
    usePlayerStore.setState({ currentTime: 10, progress: 10 / queue[1].duration });
    usePlayerStore.getState().previous();
    expect(invokeMock).toHaveBeenCalledWith('audio_seek', expect.objectContaining({ seconds: 0 }));
    expect(usePlayerStore.getState().queueIndex).toBe(1); // stayed on the same track
  });

  it('jumps to the previous track when currentTime ≤ 3 s and queueIndex > 0', () => {
    const queue = makeTracks(3);
    seedQueue(queue, { index: 2, currentTrack: queue[2] });
    usePlayerStore.setState({ currentTime: 1.0 });
    usePlayerStore.getState().previous();
    expect(usePlayerStore.getState().currentTrack?.id).toBe(queue[1].id);
    expect(usePlayerStore.getState().queueIndex).toBe(1);
  });

  it('is a no-op when queueIndex is 0 and currentTime ≤ 3 s', () => {
    const queue = makeTracks(2);
    seedQueue(queue, { index: 0, currentTrack: queue[0] });
    usePlayerStore.setState({ currentTime: 0.5 });
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
