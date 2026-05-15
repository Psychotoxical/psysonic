/**
 * Server play-queue persistence flush characterization (Phase F1 / PR 2c).
 *
 * `flushPlayQueuePosition` is the synchronous-from-the-caller's-view path
 * that the playback heartbeat / close handler / `pause()` use to push the
 * current position to the Subsonic server so cross-device resume works.
 *
 * Mocks `savePlayQueue` at the module boundary so we can assert the exact
 * args passed to the Subsonic API call.
 */
import { savePlayQueue } from '@/api/subsonicPlayQueue';
import { initAudioListeners } from './initAudioListeners';
import { flushPlayQueuePosition } from './queueSync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Explicit (non-spread) mock map — the `...actual` spread pattern lets the
// real `savePlayQueue` leak through to `playerStore.ts`'s relative import.
// Listing every export the store uses keeps the override stable.
vi.mock('@/api/subsonic', () => ({
  pingWithCredentials: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/api/subsonicPlayQueue', () => ({
  savePlayQueue: vi.fn(async () => undefined),
  getPlayQueue: vi.fn(async () => ({ songs: [], current: undefined, position: 0 })),
}));
vi.mock('@/api/subsonicStreamUrl', () => ({
  buildStreamUrl: vi.fn((id: string) => `https://mock/stream/${id}`),
  buildCoverArtUrl: vi.fn((id: string) => `https://mock/cover/${id}`),
  buildDownloadUrl: vi.fn((id: string) => `https://mock/download/${id}`),
  coverArtCacheKey: vi.fn((id: string, size = 256) => `mock:cover:${id}:${size}`),
}));
vi.mock('@/api/subsonicLibrary', () => ({
  getSong: vi.fn(async () => null),
  getRandomSongs: vi.fn(async () => []),
}));
vi.mock('@/api/subsonicArtists', () => ({
  getSimilarSongs2: vi.fn(async () => []),
  getTopSongs: vi.fn(async () => []),
}));
vi.mock('@/api/subsonicAlbumInfo', () => ({
  getAlbumInfo2: vi.fn(async () => null),
}));
vi.mock('@/api/subsonicScrobble', () => ({
  reportNowPlaying: vi.fn(async () => undefined),
  scrobbleSong: vi.fn(async () => undefined),
}));
vi.mock('@/utils/playback/playbackServer', () => ({
  getPlaybackServerId: () => 'srv-test',
  bindQueueServerForPlayback: vi.fn(),
  clearQueueServerForPlayback: vi.fn(),
  playbackServerDiffersFromActive: () => false,
  playbackCoverArtForId: (id: string, size: number) => ({
    src: `https://mock/cover/${id}?size=${size}`,
    cacheKey: `mock:cover:${id}:${size}`,
  }),
}));
vi.mock('@/api/subsonicStarRating', () => ({
  setRating: vi.fn(async () => undefined),
  probeEntityRatingSupport: vi.fn(async () => 'track_only'),
}));

vi.mock('@/api/lastfm', () => ({
  lastfmScrobble: vi.fn(async () => undefined),
  lastfmUpdateNowPlaying: vi.fn(async () => undefined),
  lastfmGetTrackLoved: vi.fn(async () => false),
  lastfmGetAllLovedTracks: vi.fn(async () => []),
}));

import { usePlayerStore } from './playerStore';
import { emitTauriEvent, onInvoke } from '@/test/mocks/tauri';
import { resetPlayerStore, resetAuthStore } from '@/test/helpers/storeReset';
import { makeTrack, makeTracks } from '@/test/helpers/factories';

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
  vi.mocked(savePlayQueue).mockClear();
  cleanupListeners = initAudioListeners();
});

afterEach(() => {
  cleanupListeners?.();
  cleanupListeners = null;
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('flushPlayQueuePosition', () => {
  it('forwards the queue, current track, and millisecond position to savePlayQueue', async () => {
    const [t1, t2, t3] = makeTracks(3);
    usePlayerStore.setState({
      queue: [t1, t2, t3],
      queueIndex: 1,
      currentTrack: t2,
      isPlaying: true,
    });
    // Drive a live-progress snapshot so flushPlayQueuePosition has a non-zero
    // position to flush — readonly snapshot is what the API call samples.
    emitTauriEvent('audio:progress', { current_time: 12.345, duration: t2.duration });
    // The audio:progress handler itself fires the 15 s heartbeat flush on the
    // first event (lastQueueHeartbeatAt starts at 0). Discard that call so the
    // assertion below targets only our explicit flushPlayQueuePosition().
    vi.mocked(savePlayQueue).mockClear();

    await flushPlayQueuePosition();

    expect(savePlayQueue).toHaveBeenCalledTimes(1);
    expect(savePlayQueue).toHaveBeenCalledWith(
      [t1.id, t2.id, t3.id],
      t2.id,
      12345, // Math.floor(12.345 * 1000)
      'srv-test',
    );
  });

  it('caps the song-id list at 1000 entries', async () => {
    const tracks = makeTracks(1100);
    usePlayerStore.setState({
      queue: tracks,
      queueIndex: 0,
      currentTrack: tracks[0],
    });
    emitTauriEvent('audio:progress', { current_time: 1, duration: tracks[0].duration });
    vi.mocked(savePlayQueue).mockClear(); // discard heartbeat call from emit

    await flushPlayQueuePosition();

    expect(savePlayQueue).toHaveBeenCalledTimes(1);
    const idsArg = vi.mocked(savePlayQueue).mock.calls[0]?.[0];
    expect(idsArg).toHaveLength(1000);
    expect(idsArg?.[999]).toBe(tracks[999].id);
  });

  it('is a no-op when a radio stream is active', async () => {
    const track = makeTrack();
    usePlayerStore.setState({
      queue: [track],
      queueIndex: 0,
      currentTrack: track,
      currentRadio: { id: 'r1', name: 'Test FM', streamUrl: 'https://radio.test/stream' },
    });

    await flushPlayQueuePosition();

    expect(savePlayQueue).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no current track', async () => {
    usePlayerStore.setState({
      queue: makeTracks(2),
      queueIndex: 0,
      currentTrack: null,
    });

    await flushPlayQueuePosition();

    expect(savePlayQueue).not.toHaveBeenCalled();
  });

  it('is a no-op when the queue is empty', async () => {
    usePlayerStore.setState({
      queue: [],
      queueIndex: 0,
      currentTrack: null,
    });

    await flushPlayQueuePosition();

    expect(savePlayQueue).not.toHaveBeenCalled();
  });

  it('swallows backend errors without propagating to the caller', async () => {
    const track = makeTrack();
    usePlayerStore.setState({ queue: [track], queueIndex: 0, currentTrack: track });
    vi.mocked(savePlayQueue).mockRejectedValueOnce(new Error('offline'));

    await expect(flushPlayQueuePosition()).resolves.toBeUndefined();
  });

  it('floors the position to whole milliseconds', async () => {
    const track = makeTrack({ duration: 200 });
    usePlayerStore.setState({
      queue: [track],
      queueIndex: 0,
      currentTrack: track,
      isPlaying: true,
    });
    emitTauriEvent('audio:progress', { current_time: 12.9999, duration: 200 });
    vi.mocked(savePlayQueue).mockClear(); // discard heartbeat call from emit

    await flushPlayQueuePosition();

    const posArg = vi.mocked(savePlayQueue).mock.calls[0]?.[2];
    expect(posArg).toBe(12999); // Math.floor(12.9999 * 1000)
  });
});
