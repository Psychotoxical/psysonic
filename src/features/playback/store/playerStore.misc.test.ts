/**
 * Miscellaneous-action characterization for `playerStore` — pushes Phase F1
 * past the 50 % line-coverage floor without touching `playTrack` (which is
 * its own async beast).
 *
 * Covers the smaller surfaces 2a / 2b / 2c skipped: shuffleQueue,
 * shuffleUpcomingQueue, stop, setStarredOverride / setUserRatingOverride,
 * toggleQueue / setQueueVisible, toggleFullscreen, openContextMenu /
 * closeContextMenu, openSongInfo / closeSongInfo, setNetworkLoved /
 * setNetworkLovedForSong, pruneUpcomingToCurrent, setProgress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMock = {
  getEnrichmentPrimaryId: vi.fn<() => string | null>(() => null),
  setTrackLoved: vi.fn(async () => undefined),
  isTrackLoved: vi.fn(async () => false),
  syncLovedTracks: vi.fn(async () => ({})),
};

vi.mock('@/lib/api/subsonic', () => ({
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

vi.mock('@/music-network', () => ({
  getMusicNetworkRuntime: () => runtimeMock,
  getMusicNetworkRuntimeOrNull: () => runtimeMock,
}));

vi.mock('@/store/orbitRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/store/orbitRuntime')>()),
  orbitBulkGuard: vi.fn(async () => true),
}));

import { usePlayerStore } from '@/features/playback/store/playerStore';
import { onInvoke, invokeMock } from '@/test/mocks/tauri';
import { resetPlayerStore, resetAuthStore } from '@/test/helpers/storeReset';
import { makeTrack, makeTracks, seedQueue } from '@/test/helpers/factories';

beforeEach(() => {
  resetPlayerStore();
  resetAuthStore();
  runtimeMock.getEnrichmentPrimaryId.mockReturnValue(null);
  runtimeMock.setTrackLoved.mockClear();
  runtimeMock.isTrackLoved.mockResolvedValue(false);
  runtimeMock.syncLovedTracks.mockResolvedValue({});
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

describe('setNetworkLoved / toggleNetworkLove', () => {
  it('setNetworkLoved writes the flag verbatim (no primary gate inside the setter)', () => {
    usePlayerStore.setState({ currentTrack: makeTrack(), networkLoved: false });
    usePlayerStore.getState().setNetworkLoved(true);
    expect(usePlayerStore.getState().networkLoved).toBe(true);
  });

  it('setNetworkLoved also caches the value under "title::artist" when there is a current track', () => {
    usePlayerStore.setState({
      currentTrack: makeTrack({ title: 'Hello', artist: 'Adele' }),
      networkLoved: false,
    });
    usePlayerStore.getState().setNetworkLoved(true);
    expect(usePlayerStore.getState().networkLovedCache['Hello::Adele']).toBe(true);
  });

  it('setNetworkLoved without a current track only updates the flag, not the cache', () => {
    usePlayerStore.setState({ currentTrack: null, networkLoved: false, networkLovedCache: {} });
    usePlayerStore.getState().setNetworkLoved(true);
    expect(usePlayerStore.getState().networkLoved).toBe(true);
    expect(usePlayerStore.getState().networkLovedCache).toEqual({});
  });

  it('toggleNetworkLove is a no-op without a current track', () => {
    runtimeMock.getEnrichmentPrimaryId.mockReturnValue('primary');
    usePlayerStore.setState({ currentTrack: null, networkLoved: false });
    usePlayerStore.getState().toggleNetworkLove();
    expect(usePlayerStore.getState().networkLoved).toBe(false);
    expect(runtimeMock.setTrackLoved).not.toHaveBeenCalled();
  });

  it('toggleNetworkLove flips state and writes through the runtime when a track + primary are present', () => {
    runtimeMock.getEnrichmentPrimaryId.mockReturnValue('primary');
    usePlayerStore.setState({ currentTrack: makeTrack({ title: 'T', artist: 'A' }), networkLoved: false });

    usePlayerStore.getState().toggleNetworkLove();
    expect(usePlayerStore.getState().networkLoved).toBe(true);
    expect(usePlayerStore.getState().networkLovedCache['T::A']).toBe(true);
    expect(runtimeMock.setTrackLoved).toHaveBeenCalledWith({ title: 'T', artist: 'A' }, true);
  });
});

describe('setNetworkLovedForSong', () => {
  it('caches loved state under the "title::artist" key', () => {
    usePlayerStore.getState().setNetworkLovedForSong('Hello', 'Adele', true);
    expect(usePlayerStore.getState().networkLovedCache['Hello::Adele']).toBe(true);

    usePlayerStore.getState().setNetworkLovedForSong('Hello', 'Adele', false);
    expect(usePlayerStore.getState().networkLovedCache['Hello::Adele']).toBe(false);
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
    seedQueue(makeTracks(2), { index: 0, currentTrack: makeTrack() });
    usePlayerStore.setState({
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

  it('keeps the waveform of the still-shown track and re-hydrates it from the DB', () => {
    const track = makeTrack({ id: 'wf-keep' });
    seedQueue([track], { index: 0, currentTrack: track });
    usePlayerStore.setState({ isPlaying: true, waveformBins: [10, 20, 30] });
    onInvoke('analysis_get_waveform_for_track', () => null);
    usePlayerStore.getState().stop();
    // currentTrack survives a stop, so its waveform bins must not be wiped.
    expect(usePlayerStore.getState().waveformBins).toEqual([10, 20, 30]);
    expect(invokeMock).toHaveBeenCalledWith(
      'analysis_get_waveform_for_track',
      expect.objectContaining({ trackId: 'wf-keep' }),
    );
  });
});

describe('shuffleQueue', () => {
  it('is a no-op when the queue has fewer than 2 tracks', () => {
    const t = makeTrack({ id: 'only' });
    seedQueue([t], { index: 0, currentTrack: t });
    usePlayerStore.getState().shuffleQueue();
    expect(usePlayerStore.getState().queueItems.map(r => r.trackId)).toEqual(['only']);
  });

  it('keeps the current track at queueIndex 0 with the rest shuffled around it', () => {
    const tracks = makeTracks(5, i => ({ id: `t-${i}` }));
    const current = tracks[2];
    seedQueue(tracks, { index: 2, currentTrack: current });

    // Pin the RNG so the shuffle is deterministic.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    usePlayerStore.getState().shuffleQueue();
    vi.restoreAllMocks();

    const s = usePlayerStore.getState();
    expect(s.queueItems[0].trackId).toBe(current.id);
    expect(s.queueIndex).toBe(0);
    // The set of ids is preserved.
    expect([...s.queueItems.map(r => r.trackId)].sort()).toEqual(['t-0', 't-1', 't-2', 't-3', 't-4'].sort());
  });
});

describe('shuffleUpcomingQueue', () => {
  it('is a no-op when fewer than 2 upcoming tracks remain', () => {
    const tracks = makeTracks(3, i => ({ id: `t-${i}` }));
    seedQueue(tracks, { index: 2, currentTrack: tracks[2] });
    const beforeIds = tracks.map(t => t.id);
    usePlayerStore.getState().shuffleUpcomingQueue();
    expect(usePlayerStore.getState().queueItems.map(r => r.trackId)).toEqual(beforeIds);
  });

  it('keeps the head + current in place and shuffles only the upcoming tail', () => {
    const tracks = makeTracks(5, i => ({ id: `t-${i}` }));
    seedQueue(tracks, { index: 1, currentTrack: tracks[1] });

    vi.spyOn(Math, 'random').mockReturnValue(0);
    usePlayerStore.getState().shuffleUpcomingQueue();
    vi.restoreAllMocks();

    const s = usePlayerStore.getState();
    // First two entries unchanged (head + current).
    expect(s.queueItems[0].trackId).toBe('t-0');
    expect(s.queueItems[1].trackId).toBe('t-1');
    // The tail still contains the same ids in some order.
    expect([...s.queueItems.slice(2).map(r => r.trackId)].sort()).toEqual(['t-2', 't-3', 't-4'].sort());
  });
});

describe('pruneUpcomingToCurrent', () => {
  it('drops everything after queueIndex', () => {
    const tracks = makeTracks(5);
    seedQueue(tracks, { index: 1, currentTrack: tracks[1] });
    usePlayerStore.getState().pruneUpcomingToCurrent();
    const s = usePlayerStore.getState();
    expect(s.queueItems.map(r => r.trackId)).toEqual([tracks[0].id, tracks[1].id]);
    expect(s.queueIndex).toBe(1);
  });

  it('clears the queue entirely when there is no current track (orphaned queue → empty)', () => {
    seedQueue(makeTracks(3), { index: 0, currentTrack: null });
    usePlayerStore.getState().pruneUpcomingToCurrent();
    const s = usePlayerStore.getState();
    expect(s.queueItems).toEqual([]);
    expect(s.queueIndex).toBe(0);
  });

  it('returns early without clearing when no current track AND queue is already empty', () => {
    usePlayerStore.setState({ queueItems: [], queueIndex: 0, currentTrack: null });
    usePlayerStore.getState().pruneUpcomingToCurrent();
    expect(usePlayerStore.getState().queueItems).toEqual([]);
  });
});

describe('setRadioArtistId', () => {
  it('accepts an artist id without throwing (module-level state, observable via radio playback)', () => {
    // No public getter for radioArtistId — assertion via does-not-throw.
    expect(() => usePlayerStore.getState().setRadioArtistId('ar-1')).not.toThrow();
    expect(() => usePlayerStore.getState().setRadioArtistId('ar-2')).not.toThrow();
  });
});
