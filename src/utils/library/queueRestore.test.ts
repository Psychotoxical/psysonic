import { describe, it, expect, beforeEach } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { usePlayerStore } from '@/store/playerStore';
import type { TrackRefDto } from '@/api/library';
import type { Track } from '@/store/playerStoreTypes';
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
    queue: [track('w1')],
    queueServerId: 's1',
    queueIndex: 0,
    currentTrack: null,
    queueRefs: undefined,
    queueRefsIndex: undefined,
    ...over,
  });
}

describe('hydrateQueueFromIndex', () => {
  beforeEach(() => {
    useLibraryIndexStore.getState().setIndexEnabled('s1', true);
    seedStore();
  });

  it('does nothing without persisted refs', async () => {
    seedStore({ queueRefs: undefined });
    await hydrateQueueFromIndex();
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual(['w1']);
  });

  it('keeps the windowed fallback when the index is not ready', async () => {
    onInvoke('library_get_status', () => ({ serverId: 's1', libraryScope: '', syncPhase: 'initial_sync' }));
    seedStore({ queueRefs: ['t1', 't2', 't3'], queueRefsIndex: 1 });
    await hydrateQueueFromIndex();
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual(['w1']);
    expect(usePlayerStore.getState().queueRefs).toEqual(['t1', 't2', 't3']); // not cleared
  });

  it('restores the full queue and re-locates the current track when ready', async () => {
    ready();
    echoBatch();
    seedStore({
      queueRefs: ['t1', 't2', 't3'],
      queueRefsIndex: 1,
      currentTrack: track('t2'),
    });
    await hydrateQueueFromIndex();
    const s = usePlayerStore.getState();
    expect(s.queue.map(t => t.id)).toEqual(['t1', 't2', 't3']);
    expect(s.queueIndex).toBe(1); // re-located to current track t2
    expect(s.queueRefs).toBeUndefined(); // cleared after success
  });

  it('batches refs in chunks of 100', async () => {
    ready();
    echoBatch();
    const refs = Array.from({ length: 150 }, (_, i) => `t${i}`);
    seedStore({ queueRefs: refs, queueRefsIndex: 0 });
    await hydrateQueueFromIndex();
    expect(usePlayerStore.getState().queue).toHaveLength(150);
  });

  it('keeps the fallback when the current track is not in the hydrated list', async () => {
    ready();
    echoBatch();
    seedStore({
      queueRefs: ['t1', 't2'],
      currentTrack: track('gone'),
    });
    await hydrateQueueFromIndex();
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual(['w1']); // unchanged
  });
});
