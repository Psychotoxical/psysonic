import { describe, it, expect, beforeEach, vi } from 'vitest';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { resetPlayerStore } from '@/test/helpers/storeReset';
import { makeTrack, seedQueue } from '@/test/helpers/factories';
import { seedQueueResolver } from '@/features/playback/store/queueTrackResolver';
import {
  playTimelineFromHere,
  playTimelineHistoryTrack,
} from '@/features/playback/utils/playTimelineHistoryTrack';

vi.mock('@/features/playback/store/queueTrackResolver', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/playback/store/queueTrackResolver')>();
  return {
    ...actual,
    resolveBatch: vi.fn(async () => undefined),
  };
});

describe('playTimelineHistoryTrack', () => {
  beforeEach(() => {
    resetPlayerStore();
  });

  it('inserts after current when the track is not in the queue', async () => {
    const a = makeTrack({ id: 'a' });
    const b = makeTrack({ id: 'b' });
    const c = makeTrack({ id: 'c' });
    const h1 = makeTrack({ id: 'h1' });
    seedQueue([a, b, c], { index: 1, currentTrack: b, serverId: 's1' });
    seedQueueResolver('s1', [h1]);
    const playTrack = vi.fn();
    usePlayerStore.setState({ playTrack });

    await playTimelineHistoryTrack('s1', 'h1');

    expect(playTrack).toHaveBeenCalledTimes(1);
    const [track, queue, , , targetIdx] = playTrack.mock.calls[0]!;
    expect(track.id).toBe('h1');
    expect(queue?.map((t: { id: string }) => t.id)).toEqual(['a', 'b', 'h1', 'c']);
    expect(targetIdx).toBe(2);
  });

  it('jumps to an upcoming slot when the track is already queued ahead', async () => {
    const a = makeTrack({ id: 'a' });
    const b = makeTrack({ id: 'b' });
    const c = makeTrack({ id: 'c' });
    seedQueue([a, b, c], { index: 0, currentTrack: a, serverId: 's1' });
    const playTrack = vi.fn();
    usePlayerStore.setState({ playTrack });

    await playTimelineHistoryTrack('s1', 'c');

    expect(playTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c' }),
      undefined,
      undefined,
      undefined,
      2,
    );
  });

  it('does not replace the queue when replaying a track that was already played in-queue', async () => {
    const a = makeTrack({ id: 'a' });
    const b = makeTrack({ id: 'b' });
    seedQueue([a, b], { index: 1, currentTrack: b, serverId: 's1' });
    const playTrack = vi.fn();
    usePlayerStore.setState({ playTrack });

    await playTimelineHistoryTrack('s1', 'a');

    expect(playTrack).toHaveBeenCalledTimes(1);
    const [, queue] = playTrack.mock.calls[0]!;
    expect(queue?.map((t: { id: string }) => t.id)).toEqual(['a', 'b', 'a']);
  });

  it('does not jump to the wrong server when track ids collide', async () => {
    const b = makeTrack({ id: 'b' });
    const s1Shared = makeTrack({ id: 'shared' });
    const s2Shared = makeTrack({ id: 'shared', serverId: 's2' });
    seedQueueResolver('s1', [s1Shared, b]);
    seedQueueResolver('s2', [s2Shared]);
    usePlayerStore.setState({
      queueItems: [
        { serverId: 's1', trackId: 'shared' },
        { serverId: 's2', trackId: 'shared' },
        { serverId: 's1', trackId: 'b' },
      ],
      queueIndex: 2,
      currentTrack: b,
      queueServerId: 's1',
      playTrack: vi.fn(),
    });
    const playTrack = usePlayerStore.getState().playTrack as ReturnType<typeof vi.fn>;

    await playTimelineHistoryTrack('s2', 'shared');

    expect(playTrack).toHaveBeenCalledTimes(1);
    const [, queue, , , targetIdx] = playTrack.mock.calls[0]!;
    expect(targetIdx).toBe(3);
    expect(queue?.map((t: { id: string }) => t.id)).toEqual(['shared', 'shared', 'b', 'shared']);
  });

  it('replaces the queue with the timeline sequence from the selected row', async () => {
    const h2 = makeTrack({ id: 'h2', serverId: 's2' });
    const h3 = makeTrack({ id: 'h3', serverId: 's1' });
    const current = makeTrack({ id: 'current', serverId: 's1' });
    const next = makeTrack({ id: 'next', serverId: 's1' });
    seedQueueResolver('s1', [h3, current, next]);
    seedQueueResolver('s2', [h2]);
    const playTrack = vi.fn();
    usePlayerStore.setState({ playTrack });

    await playTimelineFromHere([
      { serverId: 's2', trackId: 'h2' },
      { serverId: 's1', trackId: 'h3' },
      { serverId: 's1', trackId: 'current' },
      { serverId: 's1', trackId: 'next', playNextAdded: true },
    ]);

    expect(playTrack).toHaveBeenCalledTimes(1);
    const [track, queue, , , targetIdx] = playTrack.mock.calls[0]!;
    expect(track).toEqual(expect.objectContaining({ id: 'h2', serverId: 's2' }));
    expect(queue?.map((item: { id: string }) => item.id)).toEqual([
      'h2', 'h3', 'current', 'next',
    ]);
    expect(queue?.[3]).toEqual(expect.objectContaining({ playNextAdded: true }));
    expect(targetIdx).toBe(0);
  });
});
