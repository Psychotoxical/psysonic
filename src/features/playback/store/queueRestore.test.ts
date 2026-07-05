import { describe, it, expect, beforeEach } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { TrackRefDto } from '@/lib/api/library';
import type { Track } from '@/lib/media/trackTypes';
import {
  getCachedTrack,
  _resetQueueResolverForTest,
} from './queueTrackResolver';
import { hydrateQueueFromIndex } from './queueRestore';

const ready = () =>
  onInvoke('library_get_status', () => ({
    serverId: 's1',
    libraryScope: '',
    syncPhase: 'ready',
    capabilityFlags: 0,
    libraryTier: 'unknown',
    syncedAt: 0,
  }));

/** Echo each requested ref back as a minimal LibraryTrackDto (order preserved). */
const echoBatch = () =>
  onInvoke('library_get_tracks_batch', (args) =>
    (args as { refs: TrackRefDto[] }).refs.map(r => ({
      serverId: r.serverId,
      id: r.trackId,
      title: `T-${r.trackId}`,
      album: 'A',
      durationSec: 1,
      syncedAt: 0,
      rawJson: {},
    })),
  );

const track = (id: string): Track => ({ id, title: id, artist: '', album: 'A', albumId: 'A', duration: 1 });

function seedStore(over: Partial<ReturnType<typeof usePlayerStore.getState>> = {}) {
  usePlayerStore.setState({
    queueServerId: 's1',
    queueIndex: 0,
    currentTrack: null,
    queueItems: [],
    queueItemsIndex: undefined,
    queueRefs: undefined,
    queueRefsIndex: undefined,
    ...over,
  });
}

/**
 * Thin-state `hydrateQueueFromIndex`: the store is refs-canonical, so cold
 * restore eagerly resolves the whole `queueItems` ref list into the resolver
 * cache (index batch → getSong fallback) and clears the restore-pending
 * sentinel. It no longer swaps a fat `Track[]` into the store — `queueItems`
 * stays the source of truth.
 */
describe('hydrateQueueFromIndex', () => {
  beforeEach(() => {
    useLibraryIndexStore.setState({ masterEnabled: true });
    _resetQueueResolverForTest();
    seedStore();
  });

  it('does nothing without a restore-pending sentinel', async () => {
    seedStore({ queueItems: [{ serverId: 's1', trackId: 'w1' }], queueItemsIndex: undefined });
    await hydrateQueueFromIndex();
    // No resolve dispatched (no sentinel) → nothing cached.
    expect(getCachedTrack({ serverId: 's1', trackId: 'w1' })).toBeUndefined();
  });

  it('resolves the whole queueItems ref list into the resolver cache and clears the sentinel', async () => {
    ready();
    echoBatch();
    seedStore({
      queueItems: [
        { serverId: 's1', trackId: 't1' },
        { serverId: 's1', trackId: 't2' },
        { serverId: 's1', trackId: 't3' },
      ],
      queueItemsIndex: 1,
      currentTrack: track('t2'),
    });
    await hydrateQueueFromIndex();
    const s = usePlayerStore.getState();
    // queueItems stays canonical (no fat-array swap).
    expect(s.queueItems.map(r => r.trackId)).toEqual(['t1', 't2', 't3']);
    // Restore-pending sentinel cleared so it runs at most once.
    expect(s.queueItemsIndex).toBeUndefined();
    // Every ref was resolved into the cache.
    expect(getCachedTrack({ serverId: 's1', trackId: 't1' })?.id).toBe('t1');
    expect(getCachedTrack({ serverId: 's1', trackId: 't3' })?.id).toBe('t3');
  });

  it('batches refs in chunks of 100', async () => {
    ready();
    echoBatch();
    const items = Array.from({ length: 150 }, (_, i) => ({ serverId: 's1', trackId: `t${i}` }));
    seedStore({ queueItems: items, queueItemsIndex: 0 });
    await hydrateQueueFromIndex();
    // All 150 resolved into the cache (the resolver chunks ≤100/call internally).
    expect(getCachedTrack({ serverId: 's1', trackId: 't0' })?.id).toBe('t0');
    expect(getCachedTrack({ serverId: 's1', trackId: 't149' })?.id).toBe('t149');
  });

  it('upgrades a legacy queueRefs-only blob via queueServerId, then clears it', async () => {
    ready();
    echoBatch();
    seedStore({
      queueItems: [], // pre-thin-state in-memory shape
      queueRefs: ['t1', 't2', 't3'],
      queueRefsIndex: 1,
      queueServerId: 's1',
      currentTrack: track('t2'),
    });
    await hydrateQueueFromIndex();
    const s = usePlayerStore.getState();
    // Legacy refs resolved into the cache and the legacy fields cleared.
    expect(getCachedTrack({ serverId: 's1', trackId: 't1' })?.id).toBe('t1');
    expect(getCachedTrack({ serverId: 's1', trackId: 't3' })?.id).toBe('t3');
    expect(s.queueItemsIndex).toBeUndefined();
    expect(s.queueRefs).toBeUndefined();
  });

  it('clears the sentinel even when the index is not ready (best-effort getSong fallback runs)', async () => {
    onInvoke('library_get_status', () => ({ serverId: 's1', libraryScope: '', syncPhase: 'initial_sync' }));
    onInvoke('library_get_tracks_batch', () => []);
    seedStore({
      queueItems: [{ serverId: 's1', trackId: 't1' }],
      queueItemsIndex: 0,
    });
    await hydrateQueueFromIndex();
    // Sentinel cleared up front so the eager resolve runs at most once; refs stay.
    expect(usePlayerStore.getState().queueItemsIndex).toBeUndefined();
    expect(usePlayerStore.getState().queueItems.map(r => r.trackId)).toEqual(['t1']);
  });
});
