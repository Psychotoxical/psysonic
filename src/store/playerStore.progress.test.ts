/**
 * Playback-progress snapshot + subscriber characterization (Phase F1 / PR 2c).
 *
 * `getPlaybackProgressSnapshot` + `subscribePlaybackProgress` are the
 * low-overhead channel UI components (waveform, seekbar) read instead of
 * subscribing to the full Zustand store. Heavy state writes still go
 * through Zustand at the coarser store-commit interval — see
 * `playerStore.events.test.ts` for that side.
 *
 * Drive emits via the `audio:progress` Tauri event (the only public path
 * to `emitPlaybackProgress`).
 */
import { initAudioListeners } from './initAudioListeners';
import { getPlaybackProgressSnapshot, subscribePlaybackProgress, type PlaybackProgressSnapshot } from './playbackProgress';
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
    getSimilarSongs2: vi.fn(async () => []),
    getTopSongs: vi.fn(async () => []),
    getAlbumInfo2: vi.fn(async () => null),
    reportNowPlaying: vi.fn(async () => undefined),
    scrobbleSong: vi.fn(async () => undefined),
  };
});

vi.mock('@/api/lastfm', () => ({
  lastfmScrobble: vi.fn(async () => undefined),
  lastfmUpdateNowPlaying: vi.fn(async () => undefined),
  lastfmGetTrackLoved: vi.fn(async () => false),
  lastfmGetAllLovedTracks: vi.fn(async () => []),
}));

import { usePlayerStore } from './playerStore';
import { emitTauriEvent, onInvoke } from '@/test/mocks/tauri';
import { resetPlayerStore, resetAuthStore } from '@/test/helpers/storeReset';
import { makeTrack } from '@/test/helpers/factories';

function stubInvokes(): void {
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

let cleanupListeners: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  resetPlayerStore();
  resetAuthStore();
  stubInvokes();
  cleanupListeners = initAudioListeners();
});

afterEach(() => {
  cleanupListeners?.();
  cleanupListeners = null;
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('getPlaybackProgressSnapshot', () => {
  it('returns the same shape (currentTime / progress / buffered)', () => {
    const snap = getPlaybackProgressSnapshot();
    expect(snap).toHaveProperty('currentTime');
    expect(snap).toHaveProperty('progress');
    expect(snap).toHaveProperty('buffered');
    expect(typeof snap.currentTime).toBe('number');
    expect(typeof snap.progress).toBe('number');
    expect(typeof snap.buffered).toBe('number');
  });

  it('reflects a fresh audio:progress event when transport is active', () => {
    const track = makeTrack({ duration: 100 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: true });
    emitTauriEvent('audio:progress', { current_time: 42, duration: 100 });

    const snap = getPlaybackProgressSnapshot();
    expect(snap.currentTime).toBeCloseTo(42, 3);
    expect(snap.progress).toBeCloseTo(0.42, 3);
  });
});

describe('subscribePlaybackProgress', () => {
  it('notifies the subscriber on each observable update', () => {
    const track = makeTrack({ duration: 100 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: true });

    const calls: PlaybackProgressSnapshot[] = [];
    const unsub = subscribePlaybackProgress(next => calls.push(next));

    emitTauriEvent('audio:progress', { current_time: 10, duration: 100 });
    vi.advanceTimersByTime(2000); // beyond LIVE_PROGRESS_EMIT_MIN_MS = 1500
    emitTauriEvent('audio:progress', { current_time: 20, duration: 100 });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.currentTime).toBeCloseTo(10, 3);
    expect(calls[1]?.currentTime).toBeCloseTo(20, 3);

    unsub();
  });

  it('passes (next, prev) snapshots to the subscriber', () => {
    const track = makeTrack({ duration: 100 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: true });

    const pairs: Array<[PlaybackProgressSnapshot, PlaybackProgressSnapshot]> = [];
    const unsub = subscribePlaybackProgress((next, prev) => pairs.push([next, prev]));

    emitTauriEvent('audio:progress', { current_time: 5, duration: 100 });
    vi.advanceTimersByTime(2000);
    emitTauriEvent('audio:progress', { current_time: 15, duration: 100 });

    expect(pairs).toHaveLength(2);
    const [[next2, prev2]] = pairs.slice(-1);
    expect(next2.currentTime).toBeCloseTo(15, 3);
    expect(prev2.currentTime).toBeCloseTo(5, 3);

    unsub();
  });

  it('coalesces near-duplicate snapshots (epsilon guard inside emitPlaybackProgress)', () => {
    const track = makeTrack({ duration: 100 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: true });

    const calls: PlaybackProgressSnapshot[] = [];
    const unsub = subscribePlaybackProgress(next => calls.push(next));

    emitTauriEvent('audio:progress', { current_time: 10, duration: 100 });
    vi.advanceTimersByTime(2000);
    // Re-emit with a delta smaller than the snapshot's 0.005 s epsilon.
    emitTauriEvent('audio:progress', { current_time: 10.001, duration: 100 });

    expect(calls).toHaveLength(1);
    unsub();
  });

  it('stops notifying after the returned unsubscribe runs', () => {
    const track = makeTrack({ duration: 100 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: true });

    const calls: PlaybackProgressSnapshot[] = [];
    const unsub = subscribePlaybackProgress(next => calls.push(next));

    emitTauriEvent('audio:progress', { current_time: 7, duration: 100 });
    expect(calls).toHaveLength(1);

    unsub();
    vi.advanceTimersByTime(2000);
    emitTauriEvent('audio:progress', { current_time: 50, duration: 100 });

    expect(calls).toHaveLength(1);
  });

  it('supports multiple subscribers independently', () => {
    const track = makeTrack({ duration: 100 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: true });

    const a: number[] = [];
    const b: number[] = [];
    const unsubA = subscribePlaybackProgress(n => a.push(n.currentTime));
    const unsubB = subscribePlaybackProgress(n => b.push(n.currentTime));

    emitTauriEvent('audio:progress', { current_time: 11, duration: 100 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    unsubA();
    vi.advanceTimersByTime(2000);
    emitTauriEvent('audio:progress', { current_time: 21, duration: 100 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);

    unsubB();
  });
});

describe('audio:progress throttling (live-emit guard)', () => {
  it('drops a second event that fires within the time threshold and below the delta threshold', () => {
    const track = makeTrack({ duration: 100 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: true });

    const calls: PlaybackProgressSnapshot[] = [];
    const unsub = subscribePlaybackProgress(next => calls.push(next));

    emitTauriEvent('audio:progress', { current_time: 5, duration: 100 });
    // Δt only 50 ms (< 1500 ms), Δs only 0.5 (< 0.9 s) — second event dropped.
    vi.advanceTimersByTime(50);
    emitTauriEvent('audio:progress', { current_time: 5.5, duration: 100 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.currentTime).toBeCloseTo(5, 3);
    unsub();
  });

  it('lets through a second event when the position delta is large enough (≥ 0.9 s)', () => {
    const track = makeTrack({ duration: 100 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: true });

    const calls: PlaybackProgressSnapshot[] = [];
    const unsub = subscribePlaybackProgress(next => calls.push(next));

    emitTauriEvent('audio:progress', { current_time: 5, duration: 100 });
    vi.advanceTimersByTime(50);
    // Δs = 1.0 ≥ 0.9 → emit passes the live-emit gate even though Δt is small.
    emitTauriEvent('audio:progress', { current_time: 6.0, duration: 100 });

    expect(calls).toHaveLength(2);
    unsub();
  });

  it('lets through a second event when enough time has passed (≥ 1500 ms)', () => {
    const track = makeTrack({ duration: 100 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: true });

    const calls: PlaybackProgressSnapshot[] = [];
    const unsub = subscribePlaybackProgress(next => calls.push(next));

    emitTauriEvent('audio:progress', { current_time: 5, duration: 100 });
    vi.advanceTimersByTime(1600); // ≥ LIVE_PROGRESS_EMIT_MIN_MS
    emitTauriEvent('audio:progress', { current_time: 5.05, duration: 100 });

    expect(calls).toHaveLength(2);
    unsub();
  });
});
