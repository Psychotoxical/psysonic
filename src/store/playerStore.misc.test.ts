/**
 * Miscellaneous-action characterization for `playerStore` — pushes Phase F1
 * past the 50 % line-coverage floor without touching `playTrack` (which is
 * its own async beast).
 *
 * Covers the smaller surfaces 2a / 2b / 2c skipped: shuffleQueue,
 * shuffleUpcomingQueue, stop, setStarredOverride / setUserRatingOverride,
 * toggleQueue / setQueueVisible, toggleFullscreen, openContextMenu /
 * closeContextMenu, openSongInfo / closeSongInfo, setLastfmLoved /
 * setLastfmLovedForSong, pruneUpcomingToCurrent, setProgress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/subsonic', () => ({
  savePlayQueue: vi.fn(async () => undefined),
  getPlayQueue: vi.fn(async () => ({ songs: [], current: undefined, position: 0 })),
  buildStreamUrl: vi.fn((id: string) => `https://mock/stream/${id}`),
  buildCoverArtUrl: vi.fn((id: string) => `https://mock/cover/${id}`),
  buildDownloadUrl: vi.fn((id: string) => `https://mock/download/${id}`),
  coverArtCacheKey: vi.fn((id: string, size = 256) => `mock:cover:${id}:${size}`),
  getSong: vi.fn(async () => null),
  getRandomSongs: vi.fn(async () => []),
  getSimilarSongs2: vi.fn(async () => []),
  getTopSongs: vi.fn(async () => []),
  getAlbumInfo2: vi.fn(async () => null),
  reportNowPlaying: vi.fn(async () => undefined),
  scrobbleSong: vi.fn(async () => undefined),
  setRating: vi.fn(async () => undefined),
  star: vi.fn(async () => undefined),
  unstar: vi.fn(async () => undefined),
}));

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

beforeEach(() => {
  resetPlayerStore();
  resetAuthStore();
  onInvoke('audio_play', () => undefined);
  onInvoke('audio_pause', () => undefined);
  onInvoke('audio_stop', () => undefined);
  onInvoke('audio_seek', () => undefined);
  onInvoke('audio_get_state', () => ({ playing: false }));
  onInvoke('audio_update_replay_gain', () => undefined);
  onInvoke('audio_set_normalization', () => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('setStarredOverride', () => {
  it('stores per-track starred booleans', () => {
    usePlayerStore.getState().setStarredOverride('t-1', true);
    usePlayerStore.getState().setStarredOverride('t-2', false);
    expect(usePlayerStore.getState().starredOverrides).toEqual({
      't-1': true,
      't-2': false,
    });
  });
});

describe('setUserRatingOverride', () => {
  it('stores per-track rating overrides', () => {
    usePlayerStore.getState().setUserRatingOverride('t-1', 4);
    usePlayerStore.getState().setUserRatingOverride('t-2', 5);
    expect(usePlayerStore.getState().userRatingOverrides).toEqual({
      't-1': 4,
      't-2': 5,
    });
  });
});

describe('openContextMenu / closeContextMenu', () => {
  it('opens with position + item + type + queueIndex', () => {
    const track = makeTrack();
    usePlayerStore.getState().openContextMenu(100, 200, track, 'song', 5);
    const cm = usePlayerStore.getState().contextMenu;
    expect(cm.isOpen).toBe(true);
    expect(cm.x).toBe(100);
    expect(cm.y).toBe(200);
    expect(cm.type).toBe('song');
    expect(cm.queueIndex).toBe(5);
  });

  it('closeContextMenu flips isOpen but preserves the rest of the menu state', () => {
    const track = makeTrack();
    usePlayerStore.getState().openContextMenu(50, 50, track, 'song');
    usePlayerStore.getState().closeContextMenu();
    const cm = usePlayerStore.getState().contextMenu;
    expect(cm.isOpen).toBe(false);
    expect(cm.x).toBe(50);
    expect(cm.type).toBe('song');
  });
});

describe('openSongInfo / closeSongInfo', () => {
  it('opens with the song id and clears on close', () => {
    usePlayerStore.getState().openSongInfo('song-1');
    expect(usePlayerStore.getState().songInfoModal).toEqual({ isOpen: true, songId: 'song-1' });

    usePlayerStore.getState().closeSongInfo();
    expect(usePlayerStore.getState().songInfoModal).toEqual({ isOpen: false, songId: null });
  });
});

describe('toggleQueue / setQueueVisible', () => {
  it('toggleQueue flips isQueueVisible', () => {
    const before = usePlayerStore.getState().isQueueVisible;
    usePlayerStore.getState().toggleQueue();
    expect(usePlayerStore.getState().isQueueVisible).toBe(!before);
    usePlayerStore.getState().toggleQueue();
    expect(usePlayerStore.getState().isQueueVisible).toBe(before);
  });

  it('setQueueVisible writes through verbatim', () => {
    usePlayerStore.getState().setQueueVisible(true);
    expect(usePlayerStore.getState().isQueueVisible).toBe(true);
    usePlayerStore.getState().setQueueVisible(false);
    expect(usePlayerStore.getState().isQueueVisible).toBe(false);
  });
});

describe('toggleFullscreen', () => {
  it('flips isFullscreenOpen', () => {
    expect(usePlayerStore.getState().isFullscreenOpen).toBe(false);
    usePlayerStore.getState().toggleFullscreen();
    expect(usePlayerStore.getState().isFullscreenOpen).toBe(true);
    usePlayerStore.getState().toggleFullscreen();
    expect(usePlayerStore.getState().isFullscreenOpen).toBe(false);
  });
});

describe('setLastfmLoved / toggleLastfmLove', () => {
  it('setLastfmLoved writes the flag verbatim (no session-key gate inside the setter)', () => {
    usePlayerStore.setState({ currentTrack: makeTrack(), lastfmLoved: false });
    usePlayerStore.getState().setLastfmLoved(true);
    expect(usePlayerStore.getState().lastfmLoved).toBe(true);
  });

  it('setLastfmLoved also caches the value under "title::artist" when there is a current track', () => {
    usePlayerStore.setState({
      currentTrack: makeTrack({ title: 'Hello', artist: 'Adele' }),
      lastfmLoved: false,
    });
    usePlayerStore.getState().setLastfmLoved(true);
    expect(usePlayerStore.getState().lastfmLovedCache['Hello::Adele']).toBe(true);
  });

  it('setLastfmLoved without a current track only updates the flag, not the cache', () => {
    usePlayerStore.setState({ currentTrack: null, lastfmLoved: false, lastfmLovedCache: {} });
    usePlayerStore.getState().setLastfmLoved(true);
    expect(usePlayerStore.getState().lastfmLoved).toBe(true);
    expect(usePlayerStore.getState().lastfmLovedCache).toEqual({});
  });

  it('toggleLastfmLove is a no-op without a current track', () => {
    useAuthStore.setState({ lastfmSessionKey: 'session-key' });
    usePlayerStore.setState({ currentTrack: null, lastfmLoved: false });
    usePlayerStore.getState().toggleLastfmLove();
    expect(usePlayerStore.getState().lastfmLoved).toBe(false);
  });

  it('toggleLastfmLove flips state when a track + session are present', () => {
    useAuthStore.setState({ lastfmSessionKey: 'session-key' });
    usePlayerStore.setState({ currentTrack: makeTrack({ title: 'T', artist: 'A' }), lastfmLoved: false });

    usePlayerStore.getState().toggleLastfmLove();
    expect(usePlayerStore.getState().lastfmLoved).toBe(true);
    expect(usePlayerStore.getState().lastfmLovedCache['T::A']).toBe(true);
  });
});

describe('setLastfmLovedForSong', () => {
  it('caches loved state under the "title::artist" key', () => {
    usePlayerStore.getState().setLastfmLovedForSong('Hello', 'Adele', true);
    expect(usePlayerStore.getState().lastfmLovedCache['Hello::Adele']).toBe(true);

    usePlayerStore.getState().setLastfmLovedForSong('Hello', 'Adele', false);
    expect(usePlayerStore.getState().lastfmLovedCache['Hello::Adele']).toBe(false);
  });
});

describe('setProgress', () => {
  it('writes currentTime / progress / duration', () => {
    usePlayerStore.setState({ currentTrack: makeTrack({ duration: 200 }) });
    usePlayerStore.getState().setProgress(50, 200);
    const s = usePlayerStore.getState();
    expect(s.currentTime).toBe(50);
    expect(s.progress).toBeCloseTo(0.25, 4);
  });
});

describe('stop', () => {
  it('invokes audio_stop and clears playback state', () => {
    usePlayerStore.setState({
      queue: makeTracks(2),
      queueIndex: 0,
      currentTrack: makeTrack(),
      isPlaying: true,
      progress: 0.5,
      currentTime: 60,
    });
    usePlayerStore.getState().stop();
    expect(invokeMock).toHaveBeenCalledWith('audio_stop');
    const s = usePlayerStore.getState();
    expect(s.isPlaying).toBe(false);
    expect(s.progress).toBe(0);
    expect(s.currentTime).toBe(0);
  });
});

describe('shuffleQueue', () => {
  it('is a no-op when the queue has fewer than 2 tracks', () => {
    const t = makeTrack({ id: 'only' });
    usePlayerStore.setState({ queue: [t], queueIndex: 0, currentTrack: t });
    usePlayerStore.getState().shuffleQueue();
    expect(usePlayerStore.getState().queue.map(q => q.id)).toEqual(['only']);
  });

  it('keeps the current track at queueIndex 0 with the rest shuffled around it', () => {
    const tracks = makeTracks(5, i => ({ id: `t-${i}` }));
    const current = tracks[2];
    usePlayerStore.setState({ queue: tracks, queueIndex: 2, currentTrack: current });

    // Pin the RNG so the shuffle is deterministic.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    usePlayerStore.getState().shuffleQueue();
    vi.restoreAllMocks();

    const s = usePlayerStore.getState();
    expect(s.queue[0].id).toBe(current.id);
    expect(s.queueIndex).toBe(0);
    // The set of ids is preserved.
    expect([...s.queue.map(t => t.id)].sort()).toEqual(['t-0', 't-1', 't-2', 't-3', 't-4'].sort());
  });
});

describe('shuffleUpcomingQueue', () => {
  it('is a no-op when fewer than 2 upcoming tracks remain', () => {
    const tracks = makeTracks(3, i => ({ id: `t-${i}` }));
    usePlayerStore.setState({ queue: tracks, queueIndex: 2, currentTrack: tracks[2] });
    const beforeIds = tracks.map(t => t.id);
    usePlayerStore.getState().shuffleUpcomingQueue();
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual(beforeIds);
  });

  it('keeps the head + current in place and shuffles only the upcoming tail', () => {
    const tracks = makeTracks(5, i => ({ id: `t-${i}` }));
    usePlayerStore.setState({ queue: tracks, queueIndex: 1, currentTrack: tracks[1] });

    vi.spyOn(Math, 'random').mockReturnValue(0);
    usePlayerStore.getState().shuffleUpcomingQueue();
    vi.restoreAllMocks();

    const s = usePlayerStore.getState();
    // First two entries unchanged (head + current).
    expect(s.queue[0].id).toBe('t-0');
    expect(s.queue[1].id).toBe('t-1');
    // The tail still contains the same ids in some order.
    expect([...s.queue.slice(2).map(t => t.id)].sort()).toEqual(['t-2', 't-3', 't-4'].sort());
  });
});

describe('pruneUpcomingToCurrent', () => {
  it('drops everything after queueIndex', () => {
    const tracks = makeTracks(5);
    usePlayerStore.setState({ queue: tracks, queueIndex: 1, currentTrack: tracks[1] });
    usePlayerStore.getState().pruneUpcomingToCurrent();
    const s = usePlayerStore.getState();
    expect(s.queue.map(t => t.id)).toEqual([tracks[0].id, tracks[1].id]);
    expect(s.queueIndex).toBe(1);
  });

  it('clears the queue entirely when there is no current track (orphaned queue → empty)', () => {
    usePlayerStore.setState({ queue: makeTracks(3), queueIndex: 0, currentTrack: null });
    usePlayerStore.getState().pruneUpcomingToCurrent();
    const s = usePlayerStore.getState();
    expect(s.queue).toEqual([]);
    expect(s.queueIndex).toBe(0);
  });

  it('returns early without clearing when no current track AND queue is already empty', () => {
    usePlayerStore.setState({ queue: [], queueIndex: 0, currentTrack: null });
    usePlayerStore.getState().pruneUpcomingToCurrent();
    expect(usePlayerStore.getState().queue).toEqual([]);
  });
});

describe('setRadioArtistId', () => {
  it('accepts an artist id without throwing (module-level state, observable via radio playback)', () => {
    // No public getter for radioArtistId — assertion via does-not-throw.
    expect(() => usePlayerStore.getState().setRadioArtistId('ar-1')).not.toThrow();
    expect(() => usePlayerStore.getState().setRadioArtistId('ar-2')).not.toThrow();
  });
});
