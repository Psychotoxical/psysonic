import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePlayerStore } from '@/store/playerStore';
import type { Track } from '@/store/playerStoreTypes';
import { getCachedTrack, _resetQueueResolverForTest } from '@/utils/library/queueTrackResolver';
import { useQueueTrackAt, useCurrentTrack, useQueueItems } from './useQueueTracks';
// Importing the bridge registers the queue→resolver seed subscriber.
import '@/store/queueResolverBridge';

const track = (id: string, over: Partial<Track> = {}): Track =>
  ({ id, title: id, artist: '', album: 'A', albumId: 'A', duration: 1, ...over });

describe('useQueueTracks selectors', () => {
  beforeEach(() => {
    _resetQueueResolverForTest();
    usePlayerStore.setState({ queue: [], queueIndex: 0, queueServerId: 's1', currentTrack: null });
  });

  it('useQueueTrackAt returns the track at the index, or null', () => {
    usePlayerStore.setState({ queue: [track('t1'), track('t2')] });
    expect(renderHook(() => useQueueTrackAt(1)).result.current?.id).toBe('t2');
    expect(renderHook(() => useQueueTrackAt(9)).result.current).toBeNull();
  });

  it('useCurrentTrack returns the current track', () => {
    usePlayerStore.setState({ currentTrack: track('cur') });
    expect(renderHook(() => useCurrentTrack()).result.current?.id).toBe('cur');
  });

  it('useQueueItems derives thin refs (serverId + flags) from the queue', () => {
    usePlayerStore.setState({
      queueServerId: 's1',
      queue: [track('t1'), track('t2', { radioAdded: true })],
    });
    const { result } = renderHook(() => useQueueItems());
    expect(result.current).toEqual([
      { serverId: 's1', trackId: 't1' },
      { serverId: 's1', trackId: 't2', radioAdded: true },
    ]);
  });
});

describe('queueResolverBridge', () => {
  beforeEach(() => {
    _resetQueueResolverForTest();
    usePlayerStore.setState({ queue: [], queueIndex: 0, queueServerId: 's1', currentTrack: null });
  });

  it('seeds the resolver cache with tracks around the current index on queue change', () => {
    usePlayerStore.setState({ queue: [track('t1'), track('t2')], queueIndex: 0, queueServerId: 's1' });
    expect(getCachedTrack({ serverId: 's1', trackId: 't1' })?.id).toBe('t1');
    expect(getCachedTrack({ serverId: 's1', trackId: 't2' })?.id).toBe('t2');
  });

  it('does not seed when there is no playback server', () => {
    usePlayerStore.setState({ queue: [track('t1')], queueIndex: 0, queueServerId: null });
    expect(getCachedTrack({ serverId: '', trackId: 't1' })).toBeUndefined();
  });
});
