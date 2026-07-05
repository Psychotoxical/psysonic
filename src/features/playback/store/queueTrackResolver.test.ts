import { describe, it, expect, beforeEach, vi } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { TrackRefDto } from '@/lib/api/library';
import type { QueueItemRef } from '@/lib/media/trackTypes';
import * as subsonic from '@/lib/api/subsonicLibrary';
import {
  resolveBatch,
  resolveVisibleRange,
  getCachedTrack,
  placeholderTrack,
  applyQueueOverrides,
  seedQueueResolver,
  invalidateQueueResolver,
  subscribeQueueResolver,
  _resetQueueResolverForTest,
} from './queueTrackResolver';

const ready = () =>
  onInvoke('library_get_status', () => ({
    serverId: 's1', libraryScope: '', syncPhase: 'ready',
    capabilityFlags: 0, libraryTier: 'unknown', syncedAt: 0,
  }));

const notReady = () =>
  onInvoke('library_get_status', () => ({ serverId: 's1', libraryScope: '', syncPhase: 'initial_sync' }));

const echoBatch = () =>
  onInvoke('library_get_tracks_batch', (args) =>
    (args as { refs: TrackRefDto[] }).refs.map(r => ({
      serverId: r.serverId, id: r.trackId, title: `T-${r.trackId}`,
      album: 'A', durationSec: 1, syncedAt: 0, rawJson: {},
    })),
  );

const ref = (trackId: string, extra: Partial<QueueItemRef> = {}): QueueItemRef => ({ serverId: 's1', trackId, ...extra });

describe('queueTrackResolver', () => {
  beforeEach(() => {
    _resetQueueResolverForTest();
    useLibraryIndexStore.setState({ masterEnabled: true });
    usePlayerStore.setState({ starredOverrides: {}, userRatingOverrides: {} });
    vi.restoreAllMocks();
  });

  it('getCachedTrack returns undefined on a miss (no fetch)', () => {
    expect(getCachedTrack(ref('x'))).toBeUndefined();
  });

  it('resolveBatch fills the cache from the index; getCachedTrack reads it', async () => {
    ready();
    echoBatch();
    await resolveBatch([ref('t1'), ref('t2')]);
    expect(getCachedTrack(ref('t1'))?.title).toBe('T-t1');
    expect(getCachedTrack(ref('t2'))?.title).toBe('T-t2');
  });

  it('carries queue-only flags from the ref onto the resolved track', async () => {
    ready();
    echoBatch();
    await resolveBatch([ref('t1', { radioAdded: true }), ref('t2', { autoAdded: true, playNextAdded: true })]);
    expect(getCachedTrack(ref('t1'))?.radioAdded).toBe(true);
    expect(getCachedTrack(ref('t2'))?.autoAdded).toBe(true);
    expect(getCachedTrack(ref('t2'))?.playNextAdded).toBe(true);
  });

  it('falls back to network getSongForServer when the index is not ready', async () => {
    notReady();
    const spy = vi.spyOn(subsonic, 'getSongForServer').mockResolvedValue({
      id: 't9', title: 'Net Song', album: 'A', duration: 1,
    } as never);
    await resolveBatch([ref('t9')]);
    expect(spy).toHaveBeenCalledWith('s1', 't9');
    expect(getCachedTrack(ref('t9'))?.title).toBe('Net Song');
  });

  it('notifies subscribers when a fetch lands', async () => {
    ready();
    echoBatch();
    const cb = vi.fn();
    const unsub = subscribeQueueResolver(cb);
    await resolveBatch([ref('t1')]);
    expect(cb).toHaveBeenCalled();
    unsub();
  });

  it('does not re-fetch already-cached refs', async () => {
    ready();
    const batch = vi.fn((args: { refs: TrackRefDto[] }) =>
      args.refs.map(r => ({ serverId: r.serverId, id: r.trackId, title: r.trackId, album: 'A', durationSec: 1, syncedAt: 0, rawJson: {} })));
    onInvoke('library_get_tracks_batch', batch as never);
    await resolveBatch([ref('t1')]);
    await resolveBatch([ref('t1')]); // cached → no second batch call
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it('seedQueueResolver caches known tracks without a fetch', () => {
    seedQueueResolver('s1', [{ id: 't1', title: 'Seeded', artist: '', album: 'A', albumId: 'A', duration: 1 }]);
    expect(getCachedTrack(ref('t1'))?.title).toBe('Seeded');
  });

  it('invalidateQueueResolver drops the cached entry', async () => {
    ready();
    echoBatch();
    await resolveBatch([ref('t1')]);
    expect(getCachedTrack(ref('t1'))).toBeDefined();
    invalidateQueueResolver('t1');
    expect(getCachedTrack(ref('t1'))).toBeUndefined();
  });

  it('applyQueueOverrides merges session star/rating overrides', () => {
    usePlayerStore.setState({ starredOverrides: { t1: true }, userRatingOverrides: { t1: 4 } });
    const merged = applyQueueOverrides({ id: 't1', title: 'X', artist: '', album: 'A', albumId: 'A', duration: 1 });
    expect(!!merged.starred).toBe(true);
    expect(merged.userRating).toBe(4);
  });

  it('applyQueueOverrides clears starred when the override is false', () => {
    usePlayerStore.setState({ starredOverrides: { t1: false }, userRatingOverrides: {} });
    const merged = applyQueueOverrides({ id: 't1', title: 'X', artist: '', album: 'A', albumId: 'A', duration: 1, starred: '2020' });
    expect(merged.starred).toBeUndefined();
  });

  it('placeholderTrack preserves identity + queue flags', () => {
    const p = placeholderTrack(ref('t1', { radioAdded: true }));
    expect(p.id).toBe('t1');
    expect(p.radioAdded).toBe(true);
  });

  it('resolveVisibleRange prefetches the window around the visible rows', async () => {
    ready();
    const batch = vi.fn((args: { refs: TrackRefDto[] }) =>
      args.refs.map(r => ({ serverId: r.serverId, id: r.trackId, title: r.trackId, album: 'A', durationSec: 1, syncedAt: 0, rawJson: {} })));
    onInvoke('library_get_tracks_batch', batch as never);
    const refs = Array.from({ length: 400 }, (_, i) => ref(`t${i}`));
    resolveVisibleRange(refs, 100, 120);
    await vi.waitFor(() => expect(getCachedTrack(ref('t120'))).toBeDefined());
    // back window: t50 in range (100 - 50); t49 out of range
    expect(getCachedTrack(ref('t50'))).toBeDefined();
    expect(getCachedTrack(ref('t49'))).toBeUndefined();
  });
});
