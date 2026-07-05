import { describe, expect, it, vi } from 'vitest';
import { enqueuePlaylistAll, playPlaylistAll, shufflePlaylistAll } from '@/features/playlist/utils/playlistBulkPlayActions';
import type { Track } from '@/lib/media/trackTypes';

// Only id/queue identity matters for these actions.
const tracks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as unknown as Track[];

describe('playlistBulkPlayActions', () => {
  it('playPlaylistAll starts the first track with the full queue', () => {
    const playTrack = vi.fn();
    const enqueue = vi.fn();
    playPlaylistAll({ songsLength: tracks.length, id: 'p1', tracks, playTrack, enqueue });
    expect(playTrack).toHaveBeenCalledWith(tracks[0], tracks);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueuePlaylistAll appends every track without starting playback', () => {
    const playTrack = vi.fn();
    const enqueue = vi.fn();
    enqueuePlaylistAll({ songsLength: tracks.length, id: 'p1', tracks, playTrack, enqueue });
    expect(enqueue).toHaveBeenCalledWith(tracks);
    expect(playTrack).not.toHaveBeenCalled();
  });

  it('shufflePlaylistAll plays a track from the playlist with the full queue', () => {
    const playTrack = vi.fn();
    shufflePlaylistAll({ songsLength: tracks.length, id: 'p1', tracks, playTrack, enqueue: vi.fn() });
    expect(playTrack).toHaveBeenCalledTimes(1);
    const [first, queue] = playTrack.mock.calls[0];
    expect(tracks).toContain(first);
    expect(queue).toHaveLength(tracks.length);
  });

  it('no-ops on an empty playlist', () => {
    const playTrack = vi.fn();
    const enqueue = vi.fn();
    playPlaylistAll({ songsLength: 0, id: 'p1', tracks: [], playTrack, enqueue });
    shufflePlaylistAll({ songsLength: 0, id: 'p1', tracks: [], playTrack, enqueue });
    enqueuePlaylistAll({ songsLength: 0, id: 'p1', tracks: [], playTrack, enqueue });
    expect(playTrack).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('no-ops without a playlist id', () => {
    const playTrack = vi.fn();
    playPlaylistAll({ songsLength: tracks.length, id: undefined, tracks, playTrack, enqueue: vi.fn() });
    expect(playTrack).not.toHaveBeenCalled();
  });
});
