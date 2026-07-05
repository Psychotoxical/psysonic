import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSubsonicSong } from '@/test/helpers/factories';
import { onInvoke } from '@/test/mocks/tauri';
import { resetOrbitStore, resetPlayerStore } from '@/test/helpers/storeReset';
import type { Track } from '@/lib/media/trackTypes';

// Spread the real module so registerMediaResolver stays callable — the offline
// barrel loads offlineMediaResolve transitively, which registers at module init.
vi.mock('@/store/mediaResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/store/mediaResolver')>()),
  resolveAlbumForActiveServer: vi.fn(),
}));

vi.mock('@/features/playback/utils/playback/fadeOut', () => ({
  fadeOut: vi.fn(async () => undefined),
}));

import { resolveAlbumForActiveServer } from '@/store/mediaResolver';
import { useOrbitStore } from '@/features/orbit';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { playAlbum, playAlbumShuffled } from '@/features/playback/utils/playback/playAlbum';
import * as shuffleModule from '@/lib/util/shuffleArray';

const albumPayload = {
  album: {
    id: 'al-1',
    name: 'Test Album',
    artist: 'Test Artist',
    artistId: 'artist-1',
    songCount: 3,
    duration: 540,
    genre: 'Rock',
  },
  songs: [
    makeSubsonicSong({ id: 't1', title: 'One' }),
    makeSubsonicSong({ id: 't2', title: 'Two' }),
    makeSubsonicSong({ id: 't3', title: 'Three' }),
  ],
};

function stubPlaybackActions() {
  onInvoke('audio_play', () => undefined);
  onInvoke('audio_pause', () => undefined);
  onInvoke('audio_stop', () => undefined);
  onInvoke('audio_seek', () => undefined);
  onInvoke('audio_get_state', () => ({ playing: false }));
  onInvoke('audio_update_replay_gain', () => undefined);
  onInvoke('audio_set_normalization', () => undefined);
  onInvoke('discord_update_presence', () => undefined);
  onInvoke('frontend_debug_log', () => undefined);

  const playTrack = vi.fn();
  const enqueue = vi.fn();
  usePlayerStore.setState({ playTrack, enqueue });
  return { playTrack, enqueue };
}

describe('playAlbum', () => {
  beforeEach(() => {
    resetPlayerStore();
    resetOrbitStore();
    stubPlaybackActions();
    vi.mocked(resolveAlbumForActiveServer).mockResolvedValue(albumPayload);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('plays album tracks in list order', async () => {
    const { playTrack } = stubPlaybackActions();

    await playAlbum('al-1');

    expect(playTrack).toHaveBeenCalledTimes(1);
    const [, queue] = playTrack.mock.calls[0]!;
    expect(queue.map((track: Track) => track.id)).toEqual(['t1', 't2', 't3']);
    expect(queue.every((track: Track) => track.genre === 'Rock')).toBe(true);
  });

  it('enqueues instead of replacing during Orbit sessions', async () => {
    useOrbitStore.setState({ role: 'guest' });
    const { playTrack, enqueue } = stubPlaybackActions();

    await playAlbum('al-1');

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(playTrack).not.toHaveBeenCalled();
    expect(enqueue.mock.calls[0]![0].map((track: Track) => track.id)).toEqual(['t1', 't2', 't3']);
  });
});

describe('playAlbumShuffled', () => {
  beforeEach(() => {
    resetPlayerStore();
    resetOrbitStore();
    stubPlaybackActions();
    vi.mocked(resolveAlbumForActiveServer).mockResolvedValue(albumPayload);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shuffles tracks before starting playback', async () => {
    const { playTrack } = stubPlaybackActions();
    const shuffled = [
      { id: 't3' },
      { id: 't1' },
      { id: 't2' },
    ] as Track[];
    const shuffleSpy = vi.spyOn(shuffleModule, 'shuffleArray').mockReturnValue(shuffled as never);

    await playAlbumShuffled('al-1');

    expect(shuffleSpy).toHaveBeenCalledTimes(1);
    expect(playTrack).toHaveBeenCalledWith(shuffled[0], shuffled);
  });

  it('enqueues a shuffled album during Orbit sessions', async () => {
    useOrbitStore.setState({ role: 'host' });
    const { enqueue } = stubPlaybackActions();
    const shuffled = [
      { id: 't2' },
      { id: 't3' },
      { id: 't1' },
    ] as Track[];
    vi.spyOn(shuffleModule, 'shuffleArray').mockReturnValue(shuffled as never);

    await playAlbumShuffled('al-1');

    expect(enqueue).toHaveBeenCalledWith(shuffled);
  });

  it('does not start playback for an empty album', async () => {
    vi.mocked(resolveAlbumForActiveServer).mockResolvedValue({
      album: {
        id: 'al-empty',
        name: 'Empty',
        artist: 'Test Artist',
        artistId: 'artist-1',
        songCount: 0,
        duration: 0,
      },
      songs: [],
    });
    const { playTrack } = stubPlaybackActions();
    const shuffleSpy = vi.spyOn(shuffleModule, 'shuffleArray');

    await playAlbumShuffled('al-empty');

    expect(shuffleSpy).toHaveBeenCalledWith([]);
    expect(playTrack).not.toHaveBeenCalled();
  });
});
