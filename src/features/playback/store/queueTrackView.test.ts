import { describe, it, expect, beforeEach } from 'vitest';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import { seedQueueResolver, _resetQueueResolverForTest } from '@/features/playback/store/queueTrackResolver';
import { resolveQueueTrack, getQueueTracksView } from './queueTrackView';

const track = (id: string, over: Partial<Track> = {}): Track =>
  ({ id, title: id, artist: 'A', album: 'Al', albumId: 'Al', duration: 1, ...over });
const ref = (trackId: string, over: Partial<QueueItemRef> = {}): QueueItemRef =>
  ({ serverId: 's1', trackId, ...over });

describe('queueTrackView', () => {
  beforeEach(() => {
    _resetQueueResolverForTest();
    usePlayerStore.setState({ starredOverrides: {}, userRatingOverrides: {} });
  });

  it('resolves from the resolver cache when present', () => {
    seedQueueResolver('s1', [track('t1', { title: 'Cached' })]);
    expect(resolveQueueTrack(ref('t1')).title).toBe('Cached');
  });

  it('falls back to the provided Track on cache miss', () => {
    expect(resolveQueueTrack(ref('t2'), track('t2', { title: 'Fallback' })).title).toBe('Fallback');
  });

  it('returns a placeholder on miss with no fallback', () => {
    const r = resolveQueueTrack(ref('t3'));
    expect(r.id).toBe('t3');
    expect(r.title).toBe('…');
  });

  it('carries the ref queue-only flags onto the resolved track', () => {
    seedQueueResolver('s1', [track('t4')]);
    const r = resolveQueueTrack(ref('t4', { radioAdded: true }));
    expect(r.radioAdded).toBe(true);
  });

  it('merges session star/rating overrides', () => {
    seedQueueResolver('s1', [track('t5')]);
    usePlayerStore.setState({ starredOverrides: { t5: true }, userRatingOverrides: { t5: 4 } });
    const r = resolveQueueTrack(ref('t5'));
    expect(!!r.starred).toBe(true);
    expect(r.userRating).toBe(4);
  });

  it('getQueueTracksView resolves each ref, preferring cache then fallback', () => {
    seedQueueResolver('s1', [track('a', { title: 'CachedA' })]);
    const out = getQueueTracksView([ref('a'), ref('b')], [track('a'), track('b', { title: 'FbB' })]);
    expect(out.map(t => t.title)).toEqual(['CachedA', 'FbB']);
  });
});
