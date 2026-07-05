import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { Track } from '@/lib/media/trackTypes';
import {
  isMultiServerQueue,
  stampTrackServerId,
} from '@/lib/media/trackServerScope';
import {
  activeServerQueueTrackIds,
  filterQueueRefsForActiveServer,
  queueItemRefAt,
} from '@/features/playback/utils/playback/trackServerScope';

const baseTrack = (): Track => ({
  id: 't1',
  title: 'T',
  artist: 'A',
  album: 'Al',
  albumId: 'al1',
  duration: 1,
});

describe('trackServerScope', () => {
  beforeEach(() => {
    useAuthStore.setState({
      activeServerId: 'srv-active',
      servers: [{ id: 'srv-active', name: 'A', url: 'https://a.test', username: 'u', password: 'p' }],
    });
    usePlayerStore.setState({ queueItems: [], queueIndex: 0 });
  });

  it('stampTrackServerId defaults to active server', () => {
    expect(stampTrackServerId(baseTrack()).serverId).toBe('srv-active');
  });

  it('stampTrackServerId keeps an explicit serverId', () => {
    expect(stampTrackServerId({ ...baseTrack(), serverId: 'srv-b' }).serverId).toBe('srv-b');
  });

  it('queueItemRefAt tolerates missing queueItems (partial store mocks)', () => {
    usePlayerStore.setState({ queueItems: undefined as unknown as [], queueIndex: 0 });
    expect(queueItemRefAt()).toBeNull();
  });

  it('queueItemRefAt returns the playing ref', () => {
    usePlayerStore.setState({
      queueItems: [{ serverId: 'a.test', trackId: 't1' }],
      queueIndex: 0,
    });
    expect(queueItemRefAt()?.trackId).toBe('t1');
  });

  it('filterQueueRefsForActiveServer keeps only the active server bucket', () => {
    useAuthStore.setState({
      activeServerId: 'srv-a',
      servers: [
        { id: 'srv-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
        { id: 'srv-b', name: 'B', url: 'https://b.test', username: 'u', password: 'p' },
      ],
    });
    const mixed = [
      { serverId: 'a.test', trackId: 't1' },
      { serverId: 'b.test', trackId: 't2' },
      { serverId: 'srv-a', trackId: 't3' },
    ];
    expect(filterQueueRefsForActiveServer(mixed).map(r => r.trackId)).toEqual(['t1', 't3']);
    expect(activeServerQueueTrackIds(mixed)).toEqual(['t1', 't3']);
  });

  it('isMultiServerQueue detects mixed refs', () => {
    expect(isMultiServerQueue([
      { serverId: 'a.test', trackId: 't1' },
      { serverId: 'b.test', trackId: 't2' },
    ])).toBe(true);
    expect(isMultiServerQueue([
      { serverId: 'a.test', trackId: 't1' },
      { serverId: 'a.test', trackId: 't2' },
    ])).toBe(false);
  });
});
