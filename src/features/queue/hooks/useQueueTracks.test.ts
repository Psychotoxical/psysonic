import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { Track } from '@/lib/media/trackTypes';
import { getCachedTrack, _resetQueueResolverForTest } from '@/features/playback/store/queueTrackResolver';
import { seedQueue } from '@/test/helpers/factories';
import { useQueueTrackAt, useCurrentTrack, useQueueItems } from '@/features/queue/hooks/useQueueTracks';

const track = (id: string, over: Partial<Track> = {}): Track =>
  ({ id, title: id, artist: '', album: 'A', albumId: 'A', duration: 1, ...over });

describe('useQueueTracks selectors', () => {
  beforeEach(() => {
    _resetQueueResolverForTest();
    usePlayerStore.setState({
      queueItems: [], queueIndex: 0, queueServerId: 's1', currentTrack: null,
      starredOverrides: {}, userRatingOverrides: {},
    });
  });

  it('useQueueTrackAt returns the track at the index, or null', () => {
    // seedQueue seeds the resolver under serverId 's1' and sets the refs.
    seedQueue([track('t1'), track('t2')], { serverId: 's1', currentTrack: null });
    expect(renderHook(() => useQueueTrackAt(1)).result.current?.id).toBe('t2');
    expect(renderHook(() => useQueueTrackAt(9)).result.current).toBeNull();
  });

  it('useQueueTrackAt merges session star/rating overrides', () => {
    seedQueue([track('t1')], { serverId: 's1', currentTrack: null });
    usePlayerStore.setState({
      starredOverrides: { t1: true },
      userRatingOverrides: { t1: 5 },
    });
    const { result } = renderHook(() => useQueueTrackAt(0));
    expect(!!result.current?.starred).toBe(true);
    expect(result.current?.userRating).toBe(5);
  });

  it('useCurrentTrack returns the current track', () => {
    usePlayerStore.setState({ currentTrack: track('cur') });
    expect(renderHook(() => useCurrentTrack()).result.current?.id).toBe('cur');
  });

  it('useQueueItems returns the canonical thin refs (serverId + flags)', () => {
    seedQueue([track('t1'), track('t2', { radioAdded: true })], { serverId: 's1', currentTrack: null });
    const { result } = renderHook(() => useQueueItems());
    expect(result.current).toEqual([
      { serverId: 's1', trackId: 't1' },
      { serverId: 's1', trackId: 't2', radioAdded: true },
    ]);
  });
});

describe('seedQueue resolver seeding', () => {
  beforeEach(() => {
    _resetQueueResolverForTest();
    usePlayerStore.setState({ queueItems: [], queueIndex: 0, queueServerId: 's1', currentTrack: null });
  });

  it('seeds the resolver cache with the queue tracks under the queue server', () => {
    seedQueue([track('t1'), track('t2')], { serverId: 's1', currentTrack: null });
    expect(getCachedTrack({ serverId: 's1', trackId: 't1' })?.id).toBe('t1');
    expect(getCachedTrack({ serverId: 's1', trackId: 't2' })?.id).toBe('t2');
  });
});
