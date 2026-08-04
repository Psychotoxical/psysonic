/**
 * Audio-event handler characterization for `playerStore` (Phase F1 / PR 2b).
 *
 * Drives the Rust engine's `audio:*` channels through `emitTauriEvent` and
 * asserts on observable store state. Also covers the listener-lifecycle
 * regression test from §4.2 of the pre-refactor testing plan v2 — the
 * cleanup function returned by `initAudioListeners` must actually unsub.
 */
import { initAudioListeners } from '@/features/playback/store/initAudioListeners';
import { armInterruptHandoff, clearInterruptHandoff } from '@/features/playback/utils/playback/autodjInterruptPrep';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  orbitAllowsTrackServer: vi.fn(() => true),
}));

import { usePlayerStore } from '@/features/playback/store/playerStore';
import {
  emitTauriEvent,
  onInvoke,
  tauriMockListenerCount,
} from '@/test/mocks/tauri';
import { resetPlayerStore, resetAuthStore } from '@/test/helpers/storeReset';
import { makeTrack, makeTracks, seedQueue } from '@/test/helpers/factories';
import {
  _resetGaplessPreloadStateForTest,
  getBytePreloadingId,
  setBytePreloadingRequest,
} from '@/features/playback/store/gaplessPreloadState';
import { queueTrackIdentityKey } from '@/features/playback/utils/playback/queueIdentity';
import { usePlaybackAlternativeStore } from '@/features/playback/store/playbackAlternativeStore';
import { bumpPlayGeneration } from '@/features/playback/store/engineState';

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

let cleanupListeners: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  resetPlayerStore();
  resetAuthStore();
  _resetGaplessPreloadStateForTest();
  stubPlaybackInvokes();
  cleanupListeners = initAudioListeners();
});

afterEach(() => {
  cleanupListeners?.();
  cleanupListeners = null;
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('audio:progress', () => {
  it('commits currentTime to the store when transport is active', () => {
    const track = makeTrack({ duration: 100 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: true });

    // Above the 5 s store-commit threshold so the first event causes a write.
    emitTauriEvent('audio:progress', { current_time: 25, duration: 100 });

    expect(usePlayerStore.getState().currentTime).toBeCloseTo(25, 5);
    expect(usePlayerStore.getState().progress).toBeCloseTo(0.25, 5);
  });

  it('is ignored when there is no current track', () => {
    usePlayerStore.setState({ currentTrack: null, currentTime: 0 });
    emitTauriEvent('audio:progress', { current_time: 25, duration: 100 });
    expect(usePlayerStore.getState().currentTime).toBe(0);
  });

  it('is ignored when transport is inactive (paused, no radio)', () => {
    const track = makeTrack({ duration: 100 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: false, currentTime: 0 });
    emitTauriEvent('audio:progress', { current_time: 25, duration: 100 });
    expect(usePlayerStore.getState().currentTime).toBe(0);
  });

  it('uses the track duration when the event reports duration ≤ 0', () => {
    const track = makeTrack({ duration: 200 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: true });
    emitTauriEvent('audio:progress', { current_time: 50, duration: 0 });
    // Falls back to track.duration = 200, so progress = 50/200 = 0.25.
    expect(usePlayerStore.getState().progress).toBeCloseTo(0.25, 5);
  });
});

describe('audio:track_switched', () => {
  it('advances to queue[queueIndex + 1] under repeatMode=off', () => {
    const queue = makeTracks(3);
    seedQueue(queue, { index: 0, currentTrack: queue[0] });
    usePlayerStore.setState({ repeatMode: 'off' });
    emitTauriEvent('audio:track_switched', queue[1].duration);
    const s = usePlayerStore.getState();
    expect(s.currentTrack?.id).toBe(queue[1].id);
    expect(s.queueIndex).toBe(1);
    expect(s.isPlaying).toBe(true);
    expect(s.scrobbled).toBe(false);
    expect(s.progress).toBe(0);
    expect(s.currentTime).toBe(0);
  });

  it('clears the predecessor resolved stream format on gapless advance', () => {
    const queue = makeTracks(3);
    seedQueue(queue, { index: 0, currentTrack: queue[0] });
    usePlayerStore.setState({
      repeatMode: 'off',
      resolvedStreamFormat: { trackId: queue[0].id, codec: 'flac', lossless: true },
    });
    emitTauriEvent('audio:track_switched', queue[1].duration);
    // The successor's format arrives via its own audio:format emit; until
    // then the predecessor's must not linger on the new track.
    expect(usePlayerStore.getState().resolvedStreamFormat).toBeNull();
  });

  it('replays the same track under repeatMode=one (queueIndex stays put)', () => {
    const queue = makeTracks(3);
    seedQueue(queue, { index: 1, currentTrack: queue[1] });
    usePlayerStore.setState({ repeatMode: 'one' });
    emitTauriEvent('audio:track_switched', queue[1].duration);
    const s = usePlayerStore.getState();
    expect(s.currentTrack?.id).toBe(queue[1].id);
    expect(s.queueIndex).toBe(1);
  });

  it('wraps to queue[0] when at the end with repeatMode=all', () => {
    const queue = makeTracks(3);
    seedQueue(queue, { index: 2, currentTrack: queue[2] });
    usePlayerStore.setState({ repeatMode: 'all' });
    emitTauriEvent('audio:track_switched', queue[0].duration);
    const s = usePlayerStore.getState();
    expect(s.currentTrack?.id).toBe(queue[0].id);
    expect(s.queueIndex).toBe(0);
  });

  it('is a no-op when at the end with repeatMode=off', () => {
    const queue = makeTracks(2);
    seedQueue(queue, { index: 1, currentTrack: queue[1] });
    usePlayerStore.setState({ repeatMode: 'off' });
    emitTauriEvent('audio:track_switched', queue[1].duration);
    // No next candidate → handler returns early before state changes.
    const s = usePlayerStore.getState();
    expect(s.currentTrack?.id).toBe(queue[1].id);
    expect(s.queueIndex).toBe(1);
  });

  it('resets scrobbled + networkLoved flags so the new track can be rescored', () => {
    const queue = makeTracks(2);
    seedQueue(queue, { index: 0, currentTrack: queue[0] });
    usePlayerStore.setState({ scrobbled: true, networkLoved: true });
    emitTauriEvent('audio:track_switched', queue[1].duration);
    expect(usePlayerStore.getState().scrobbled).toBe(false);
    expect(usePlayerStore.getState().networkLoved).toBe(false);
  });
});

describe('audio:ended', () => {
  // Module-scope `lastGaplessSwitchTime` is updated by handleAudioTrackSwitched
  // in adjacent tests; the ghost-guard skips audio:ended events fired within
  // 600 ms of a track switch. Advance the fake clock to bypass the guard.
  beforeEach(() => {
    vi.advanceTimersByTime(1000);
  });

  it('immediately resets playback bookkeeping (before the 150 ms next() timer)', () => {
    const queue = makeTracks(2);
    seedQueue(queue, { index: 0, currentTrack: queue[0] });
    usePlayerStore.setState({
      isPlaying: true,
      progress: 0.99,
      currentTime: 178,
      buffered: 1,
    });
    emitTauriEvent('audio:ended', undefined);
    const s = usePlayerStore.getState();
    expect(s.isPlaying).toBe(false);
    expect(s.progress).toBe(0);
    expect(s.currentTime).toBe(0);
    expect(s.buffered).toBe(0);
    // currentTrack stays — `next()` (deferred 150 ms) will replace it.
    expect(s.currentTrack?.id).toBe(queue[0].id);
  });

  it('ignores ended while an interrupt handoff is pending', () => {
    const queue = makeTracks(2);
    seedQueue(queue, { index: 0, currentTrack: queue[1] });
    usePlayerStore.setState({ isPlaying: true, progress: 0.5, currentTime: 90 });
    armInterruptHandoff(1);
    emitTauriEvent('audio:ended', undefined);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    clearInterruptHandoff();
  });

  it('clears state and currentRadio for a radio stream without advancing the queue', () => {
    const queue = makeTracks(2);
    seedQueue(queue, { index: 0, currentTrack: queue[0] });
    usePlayerStore.setState({
      currentRadio: { id: 'r1', name: 'Test FM', streamUrl: 'https://radio.test/stream' },
      isPlaying: true,
    });
    emitTauriEvent('audio:ended', undefined);
    const s = usePlayerStore.getState();
    expect(s.isPlaying).toBe(false);
    expect(s.currentRadio).toBeNull();
    expect(s.progress).toBe(0);
    expect(s.currentTime).toBe(0);
    // Queue not advanced.
    expect(s.queueIndex).toBe(0);
    expect(s.currentTrack?.id).toBe(queue[0].id);
  });
});

describe('audio:error', () => {
  it('skips the failed slot when no alternative source exists', async () => {
    const queue = makeTracks(2);
    seedQueue(queue, { index: 0, currentTrack: queue[0] });
    const next = vi.fn();
    usePlayerStore.setState({ isPlaying: true, next });

    emitTauriEvent('audio:error', 'decoder failed');
    await vi.waitFor(() => expect(usePlaybackAlternativeStore.getState().status).toBe('ready'));
    vi.advanceTimersByTime(1_500);

    const player = usePlayerStore.getState();
    expect(next).toHaveBeenCalledWith(false);
    expect(player.queueIndex).toBe(0);
    expect(player.currentTrack?.id).toBe(queue[0].id);
    expect(player.isPlaying).toBe(false);
    expect(usePlaybackAlternativeStore.getState().failure).toEqual(expect.objectContaining({
      queueIndex: 0,
      detail: 'decoder failed',
    }));
  });

  it('does not skip after the user changes playback generation', async () => {
    const queue = makeTracks(2);
    seedQueue(queue, { index: 0, currentTrack: queue[0] });
    const next = vi.fn();
    usePlayerStore.setState({ isPlaying: true, next });

    emitTauriEvent('audio:error', 'decoder failed');
    await vi.waitFor(() => expect(usePlaybackAlternativeStore.getState().status).toBe('ready'));
    bumpPlayGeneration();
    vi.advanceTimersByTime(1_500);

    expect(next).not.toHaveBeenCalled();
  });
});

describe('audio preload events', () => {
  it('does not let a stale cancellation clear a newer owner-qualified request', () => {
    const identity = queueTrackIdentityKey('shared', 'srv-b');
    const currentUrl = 'https://b.test/stream?id=shared';
    setBytePreloadingRequest(identity, currentUrl);

    emitTauriEvent('audio:preload-cancelled', {
      url: 'https://a.test/stream?id=shared',
      trackId: 'shared',
    });

    expect(getBytePreloadingId()).toBe(identity);

    emitTauriEvent('audio:preload-ready', {
      url: 'https://a.test/stream?id=shared',
      trackId: 'shared',
    });
    expect(usePlayerStore.getState().enginePreloadedTrackId).toBeNull();

    // URL parsing is intentionally not an identity fallback: the native event
    // must name the track and match the exact pending request URL.
    emitTauriEvent('audio:preload-ready', { url: currentUrl });
    expect(usePlayerStore.getState().enginePreloadedTrackId).toBeNull();

    emitTauriEvent('audio:preload-ready', {
      url: currentUrl,
      trackId: 'shared',
    });

    expect(usePlayerStore.getState().enginePreloadedTrackId).toBe(identity);
  });
});

describe('initAudioListeners — listener lifecycle (regression §4.2)', () => {
  it('registers exactly one listener per audio:* channel', () => {
    // beforeEach already called initAudioListeners once.
    expect(tauriMockListenerCount('audio:progress')).toBe(1);
    expect(tauriMockListenerCount('audio:ended')).toBe(1);
    expect(tauriMockListenerCount('audio:track_switched')).toBe(1);
    expect(tauriMockListenerCount('audio:playing')).toBe(1);
  });

  it('cleanup() removes all audio:* listeners it registered', async () => {
    // Tear down the listeners attached by beforeEach.
    cleanupListeners?.();
    cleanupListeners = null;
    // `pending.forEach(p => p.then(unlisten => unlisten()))` runs in microtasks
    // — flush twice to ride through the then-chain.
    await Promise.resolve();
    await Promise.resolve();
    expect(tauriMockListenerCount('audio:progress')).toBe(0);
    expect(tauriMockListenerCount('audio:ended')).toBe(0);
    expect(tauriMockListenerCount('audio:track_switched')).toBe(0);
    expect(tauriMockListenerCount('audio:playing')).toBe(0);
  });

  it('re-init after cleanup keeps the count at 1 (no leak)', async () => {
    cleanupListeners?.();
    cleanupListeners = null;
    await Promise.resolve();
    await Promise.resolve();
    cleanupListeners = initAudioListeners();
    expect(tauriMockListenerCount('audio:progress')).toBe(1);
    expect(tauriMockListenerCount('audio:track_switched')).toBe(1);
  });

  it('init without cleanup stacks listeners — guards against missing useEffect cleanup', () => {
    // Demonstrates the pre-ShortcutMap bug shape: calling init twice without
    // tearing down accumulates handlers. The Real Fix lives in the consumer
    // (React useEffect cleanup); this test pins the contract so a refactor
    // that silently swallows the cleanup return value fails loudly.
    const second = initAudioListeners();
    expect(tauriMockListenerCount('audio:progress')).toBe(2);
    second();
  });
});
