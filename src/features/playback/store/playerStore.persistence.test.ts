/**
 * Player store persistence: server play-queue flush (Phase F1 / PR 2c) and
 * localStorage partialize windowing (PR #756).
 *
 * `flushPlayQueuePosition` is the synchronous-from-the-caller's-view path
 * that the playback heartbeat / close handler / `pause()` use to push the
 * current position to the Subsonic server so cross-device resume works.
 *
 * `partialize` caps the localStorage queue to a ±250-track window around the
 * current index, remapping `queueIndex` into the slice so the persisted
 * snapshot stays self-consistent and within the browser storage quota.
 *
 * Mocks `savePlayQueue` at the module boundary so we can assert the exact
 * args passed to the Subsonic API call.
 */
import { savePlayQueue } from '@/lib/api/subsonicPlayQueue';
import { initAudioListeners } from '@/features/playback/store/initAudioListeners';
import { flushPlayQueuePosition } from '@/features/playback/store/queueSync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Explicit (non-spread) mock map — the `...actual` spread pattern lets the
// real `savePlayQueue` leak through to `playerStore.ts`'s relative import.
// Listing every export the store uses keeps the override stable.
vi.mock('@/lib/api/subsonic', () => ({
  pingWithCredentials: vi.fn(async () => ({ ok: true })),
  pingWithCredentialsForProfile: vi.fn(async () => ({ ok: true })),
  scheduleInstantMixProbeForServer: vi.fn(),
}));
vi.mock('@/lib/api/subsonicPlayQueue', () => ({
  savePlayQueue: vi.fn(async () => undefined),
  getPlayQueue: vi.fn(async () => ({ songs: [], current: undefined, position: 0 })),
}));
vi.mock('@/lib/network/activeServerReachability', () => ({
  isActiveServerReachable: () => true,
}));
vi.mock('@/lib/api/subsonicStreamUrl', () => ({
  buildStreamUrl: vi.fn((id: string) => `https://mock/stream/${id}`),
  buildCoverArtUrl: vi.fn((id: string) => `https://mock/cover/${id}`),
  buildDownloadUrl: vi.fn((id: string) => `https://mock/download/${id}`),
  coverArtCacheKey: vi.fn((id: string, size = 256) => `mock:cover:${id}:${size}`),
}));
vi.mock('@/lib/api/subsonicLibrary', () => ({
  getSong: vi.fn(async () => null),
  getRandomSongs: vi.fn(async () => []),
}));
vi.mock('@/lib/api/subsonicArtists', () => ({
  getSimilarSongs2: vi.fn(async () => []),
  getTopSongs: vi.fn(async () => []),
}));
vi.mock('@/lib/api/subsonicAlbumInfo', () => ({
  getAlbumInfo2: vi.fn(async () => null),
}));
vi.mock('@/lib/api/subsonicScrobble', () => ({
  reportNowPlaying: vi.fn(async () => undefined),
  scrobbleSong: vi.fn(async () => undefined),
}));
vi.mock('@/features/playback/utils/playback/playbackServer', () => ({
  getPlaybackServerId: () => 'srv-test',
  bindQueueServerForPlayback: vi.fn(),
  clearQueueServerForPlayback: vi.fn(),
  playbackServerDiffersFromActive: () => false,
  filterQueueRefsForPlaybackServer: (refs: { serverId: string; trackId: string }[]) => refs,
  playbackProfileIdForTrack: (track: { serverId?: string } | null) => track?.serverId ?? 'srv-test',
  playbackCoverArtForId: (id: string, size: number) => ({
    src: `https://mock/cover/${id}?size=${size}`,
    cacheKey: `mock:cover:${id}:${size}`,
  }),
}));
vi.mock('@/lib/api/subsonicStarRating', () => ({
  setRating: vi.fn(async () => undefined),
  probeEntityRatingSupport: vi.fn(async () => 'track_only'),
}));


import { usePlayerStore } from '@/features/playback/store/playerStore';
import { emitTauriEvent, onInvoke } from '@/test/mocks/tauri';
import { resetPlayerStore, resetAuthStore } from '@/test/helpers/storeReset';
import { makeTrack, makeTracks, seedQueue } from '@/test/helpers/factories';

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
    seedQueue([t1, t2, t3], { index: 1, currentTrack: t2 });
    usePlayerStore.setState({ isPlaying: true });
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
    seedQueue(tracks, { index: 0, currentTrack: tracks[0] });
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
    seedQueue([track], { index: 0, currentTrack: track });
    usePlayerStore.setState({
      currentRadio: { id: 'r1', name: 'Test FM', streamUrl: 'https://radio.test/stream' },
    });

    await flushPlayQueuePosition();

    expect(savePlayQueue).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no current track', async () => {
    seedQueue(makeTracks(2), { index: 0, currentTrack: null });

    await flushPlayQueuePosition();

    expect(savePlayQueue).not.toHaveBeenCalled();
  });

  it('is a no-op when the queue is empty', async () => {
    usePlayerStore.setState({
      queueItems: [],
      queueIndex: 0,
      currentTrack: null,
    });

    await flushPlayQueuePosition();

    expect(savePlayQueue).not.toHaveBeenCalled();
  });

  it('swallows backend errors without propagating to the caller', async () => {
    const track = makeTrack();
    seedQueue([track], { index: 0, currentTrack: track });
    vi.mocked(savePlayQueue).mockRejectedValueOnce(new Error('offline'));

    await expect(flushPlayQueuePosition()).resolves.toBeUndefined();
  });

  it('floors the position to whole milliseconds', async () => {
    const track = makeTrack({ duration: 200 });
    seedQueue([track], { index: 0, currentTrack: track });
    usePlayerStore.setState({ isPlaying: true });
    emitTauriEvent('audio:progress', { current_time: 12.9999, duration: 200 });
    vi.mocked(savePlayQueue).mockClear(); // discard heartbeat call from emit

    await flushPlayQueuePosition();

    const posArg = vi.mocked(savePlayQueue).mock.calls[0]?.[2];
    expect(posArg).toBe(12999); // Math.floor(12.9999 * 1000)
  });
});

// ---------------------------------------------------------------------------
// partialize + merge: thin-state refs-only persistence
// ---------------------------------------------------------------------------

function getPartialize() {
  // zustand persist middleware exposes config (incl. partialize) via .persist
  type PartializeFn = (state: ReturnType<typeof usePlayerStore.getState>) => Record<string, unknown>;
  return (usePlayerStore as unknown as { persist: { getOptions(): { partialize: PartializeFn } } })
    .persist.getOptions().partialize;
}

function getMerge() {
  type MergeFn = (persisted: unknown, current: ReturnType<typeof usePlayerStore.getState>) => ReturnType<typeof usePlayerStore.getState>;
  return (usePlayerStore as unknown as { persist: { getOptions(): { merge: MergeFn } } })
    .persist.getOptions().merge;
}

describe('partialize: thin queueItems (refs only)', () => {
  it('persists the WHOLE queue as thin refs (no windowed fat `queue`)', () => {
    const tracks = makeTracks(600);
    tracks[3].radioAdded = true;
    tracks[4].autoAdded = true;
    seedQueue(tracks, { index: 300, serverId: 's1', currentTrack: tracks[300] });

    const partial = getPartialize()(usePlayerStore.getState());
    const items = partial.queueItems as {
      serverId: string; trackId: string; radioAdded?: boolean; autoAdded?: boolean;
    }[];

    // No fat `queue` key anymore.
    expect(partial.queue).toBeUndefined();
    // queueItems carries the WHOLE queue.
    expect(items.length).toBe(600);
    // queueItemsIndex is the restore-pending sentinel (= the live queueIndex).
    expect(partial.queueItemsIndex).toBe(300);
    expect(items[0].serverId).toBe('s1');
    expect(items[3].radioAdded).toBe(true);
    expect(items[4].autoAdded).toBe(true);
    expect(items[0].radioAdded).toBeUndefined();
  });

  it('handles an empty queue without throwing', () => {
    usePlayerStore.setState({ queueItems: [], queueIndex: 0 });

    const partial = getPartialize()(usePlayerStore.getState());

    expect((partial.queueItems as unknown[]).length).toBe(0);
    expect(partial.queue).toBeUndefined();
  });
});

describe('merge: restores the queue from any old persisted blob', () => {
  const current = () => usePlayerStore.getState();

  it('prefers an existing queueItems ref list + sets the sentinel', () => {
    const merged = getMerge()(
      {
        queueServerId: 's1',
        queueIndex: 2,
        queueItems: [
          { serverId: 's1', trackId: 'a' },
          { serverId: 's1', trackId: 'b' },
        ],
        queueItemsIndex: 1,
      },
      current(),
    );
    expect(merged.queueItems.map(r => r.trackId)).toEqual(['a', 'b']);
    expect(merged.queueItemsIndex).toBe(1);
  });

  it('rebuilds queueItems from a legacy queueRefs string list', () => {
    const merged = getMerge()(
      { queueServerId: 's2', queueRefs: ['x', 'y'], queueRefsIndex: 1 },
      current(),
    );
    expect(merged.queueItems).toEqual([
      { serverId: 's2', trackId: 'x' },
      { serverId: 's2', trackId: 'y' },
    ]);
    expect(merged.queueItemsIndex).toBe(1);
  });

  it('rebuilds queueItems from an old windowed fat `queue: Track[]` blob and drops the `queue` key', () => {
    const blob: Record<string, unknown> = {
      queueServerId: 's3',
      queueIndex: 1,
      queue: [makeTrack({ id: 'q0' }), makeTrack({ id: 'q1', radioAdded: true })],
    };
    const merged = getMerge()(blob, current());
    expect(merged.queueItems).toEqual([
      { serverId: 's3', trackId: 'q0' },
      { serverId: 's3', trackId: 'q1', radioAdded: true },
    ]);
    // The windowed fat-array key is deleted from the persisted blob.
    expect('queue' in blob).toBe(false);
    // Sentinel falls back to the persisted queueIndex when no explicit index.
    expect(merged.queueItemsIndex).toBe(1);
  });

  it('leaves an empty queue alone (no sentinel) when the blob has nothing to restore', () => {
    const merged = getMerge()({ queueServerId: null }, current());
    expect(merged.queueItems).toEqual([]);
    expect(merged.queueItemsIndex).toBeUndefined();
  });
});
