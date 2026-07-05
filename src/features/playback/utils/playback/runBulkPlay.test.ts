import { describe, expect, it, vi } from 'vitest';
import type { Track } from '@/lib/media/trackTypes';
import { runBulkEnqueue, runBulkPlayAll, runBulkShuffle } from '@/features/playback/utils/playback/runBulkPlay';

function track(id: string): Track {
  return { id, title: id } as Track;
}

describe('runBulkPlayAll', () => {
  it('plays the first track with the full list as queue and toggles loading', async () => {
    const tracks = [track('a'), track('b'), track('c')];
    const setLoading = vi.fn();
    const playTrack = vi.fn();
    await runBulkPlayAll({ fetchTracks: async () => tracks, setLoading, playTrack });
    expect(playTrack).toHaveBeenCalledWith(tracks[0], tracks);
    expect(setLoading.mock.calls).toEqual([[true], [false]]);
  });

  it('does not start playback for an empty genre but still clears loading', async () => {
    const setLoading = vi.fn();
    const playTrack = vi.fn();
    await runBulkPlayAll({ fetchTracks: async () => [], setLoading, playTrack });
    expect(playTrack).not.toHaveBeenCalled();
    expect(setLoading).toHaveBeenLastCalledWith(false);
  });

  it('clears loading even when fetching throws', async () => {
    const setLoading = vi.fn();
    await expect(
      runBulkPlayAll({ fetchTracks: async () => { throw new Error('boom'); }, setLoading, playTrack: vi.fn() }),
    ).rejects.toThrow('boom');
    expect(setLoading).toHaveBeenLastCalledWith(false);
  });
});

describe('runBulkShuffle', () => {
  it('plays a permutation of the same tracks, head consistent with the queue', async () => {
    const tracks = Array.from({ length: 25 }, (_, i) => track(String(i)));
    const playTrack = vi.fn();
    await runBulkShuffle({ fetchTracks: async () => tracks, setLoading: vi.fn(), playTrack });
    const [head, queue] = playTrack.mock.calls[0];
    expect(queue).toHaveLength(tracks.length);
    expect(queue[0]).toBe(head);
    expect([...queue].map(t => t.id).sort()).toEqual([...tracks].map(t => t.id).sort());
  });
});

describe('runBulkEnqueue', () => {
  it('enqueues all fetched tracks', async () => {
    const tracks = [track('a'), track('b')];
    const enqueue = vi.fn();
    await runBulkEnqueue({ fetchTracks: async () => tracks, setLoading: vi.fn(), enqueue });
    expect(enqueue).toHaveBeenCalledWith(tracks);
  });

  it('skips enqueue when there are no tracks', async () => {
    const enqueue = vi.fn();
    await runBulkEnqueue({ fetchTracks: async () => [], setLoading: vi.fn(), enqueue });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
