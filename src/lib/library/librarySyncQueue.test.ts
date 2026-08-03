import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emitTauriEvent, listenMock, onInvoke } from '@/test/mocks/tauri';
import {
  clearPendingLibrarySync,
  enqueueLibrarySync,
  hasLibrarySyncWork,
  resetLibrarySyncQueueForTests,
} from './librarySyncQueue';
import {
  readArtistBrowseCatalogCache,
  storeArtistBrowseCatalogCache,
} from './artistBrowseInflight';
import {
  readAlbumBrowseCatalogCache,
  storeAlbumBrowseCatalogCache,
} from './albumBrowseInflight';
import {
  __resetArtistIdResolveCacheForTests,
  peekArtistIdByName,
  resolveArtistIdsByName,
} from './artistIdResolve';

function mockSyncStart() {
  const start = vi.fn(async (args: unknown) => {
    const { serverId } = args as { serverId: string; mode: string };
    queueMicrotask(() =>
      emitTauriEvent('library:sync-idle', {
        serverId,
        libraryScope: '',
        kind: 'initial_sync',
        jobId: `j-${serverId}`,
        ok: true,
      }),
    );
    return { jobId: `j-${serverId}`, serverId, kind: 'initial_sync' };
  });
  onInvoke('library_sync_start', start);
  return start;
}

describe('librarySyncQueue', () => {
  beforeEach(() => {
    resetLibrarySyncQueueForTests();
    __resetArtistIdResolveCacheForTests();
  });

  it('runs queued syncs one server at a time', async () => {
    const order: string[] = [];
    onInvoke('library_sync_start', async (args: unknown) => {
      const { serverId } = args as { serverId: string };
      order.push(`start:${serverId}`);
      await new Promise(r => setTimeout(r, 5));
      queueMicrotask(() => {
        order.push(`idle:${serverId}`);
        emitTauriEvent('library:sync-idle', {
          serverId,
          libraryScope: '',
          kind: 'initial_sync',
          jobId: `j-${serverId}`,
          ok: true,
        });
      });
      return { jobId: `j-${serverId}`, serverId, kind: 'initial_sync' };
    });

    await Promise.all([
      enqueueLibrarySync({ serverId: 'a', kind: 'full' }),
      enqueueLibrarySync({ serverId: 'b', kind: 'full' }),
    ]);

    expect(order).toEqual(['start:a', 'idle:a', 'start:b', 'idle:b']);
  });

  it('rejects the queue item when sync-idle reports failure', async () => {
    mockSyncStart();
    onInvoke('library_sync_start', async (args: unknown) => {
      const { serverId } = args as { serverId: string };
      queueMicrotask(() =>
        emitTauriEvent('library:sync-idle', {
          serverId,
          libraryScope: '',
          kind: 'initial_sync',
          jobId: 'j1',
          ok: false,
          error: 'boom',
        }),
      );
      return { jobId: 'j1', serverId, kind: 'initial_sync' };
    });

    await expect(enqueueLibrarySync({ serverId: 's1', kind: 'full' })).rejects.toThrow(
      'boom',
    );
  });

  it('resets after listener subscription failure and permits a later retry', async () => {
    listenMock.mockRejectedValueOnce(new Error('listen failed'));
    await expect(enqueueLibrarySync({ serverId: 's1', kind: 'full' })).rejects.toThrow(
      'listen failed',
    );
    expect(hasLibrarySyncWork('s1')).toBe(false);

    const start = mockSyncStart();
    await expect(enqueueLibrarySync({ serverId: 's1', kind: 'full' })).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('keeps foreground queue work pending across successful background idle events', async () => {
    const start = vi.fn(async (args: unknown) => {
      const { serverId } = args as { serverId: string };
      return { jobId: 'j1', serverId, kind: 'initial_sync' };
    });
    onInvoke('library_sync_start', start);
    const queued = enqueueLibrarySync({ serverId: 's1', kind: 'full' });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    emitTauriEvent('library:sync-idle', {
      serverId: 's1', libraryScope: '', kind: 'delta_sync', source: 'background', ok: true,
    });
    await Promise.resolve();
    expect(hasLibrarySyncWork('s1')).toBe(true);

    emitTauriEvent('library:sync-idle', {
      serverId: 's1', libraryScope: '', kind: 'initial_sync', source: 'foreground', jobId: 'j1', ok: true,
    });
    await expect(queued).resolves.toBeUndefined();
  });

  it('ignores the cancelled predecessor idle while a replacement start is in flight', async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
    const start = vi.fn(async (args: unknown) => {
      const { serverId } = args as { serverId: string };
      emitTauriEvent('library:sync-idle', {
        serverId,
        libraryScope: '',
        kind: 'initial_sync',
        source: 'foreground',
        jobId: 'old-job',
        ok: true,
      });
      await startGate;
      return { jobId: 'new-job', serverId, kind: 'initial_sync' };
    });
    onInvoke('library_sync_start', start);

    const queued = enqueueLibrarySync({ serverId: 's1', kind: 'full' });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(hasLibrarySyncWork('s1')).toBe(true);

    releaseStart();
    await Promise.resolve();
    expect(hasLibrarySyncWork('s1')).toBe(true);

    emitTauriEvent('library:sync-idle', {
      serverId: 's1',
      libraryScope: '',
      kind: 'initial_sync',
      source: 'foreground',
      jobId: 'new-job',
      ok: true,
    });
    await expect(queued).resolves.toBeUndefined();
  });

  it('evicts buffered artist/album catalogs on a successful sync-idle', async () => {
    storeArtistBrowseCatalogCache('artist-key', { artists: [], hasMore: false });
    storeAlbumBrowseCatalogCache('album-key', { albums: [], hasMore: false });
    expect(readArtistBrowseCatalogCache('artist-key')).toBeDefined();
    expect(readAlbumBrowseCatalogCache('album-key')).toBeDefined();

    mockSyncStart();
    await enqueueLibrarySync({ serverId: 's1', kind: 'full' });

    expect(readArtistBrowseCatalogCache('artist-key')).toBeUndefined();
    expect(readAlbumBrowseCatalogCache('album-key')).toBeUndefined();
  });

  // Sync writes incrementally: a run can insert artist rows and still report failure
  // on a later pass. A cached "no artist row" from before that run would then survive
  // the very write that created the row, leaving the guest unlinkable until restart.
  it('drops cached artist-id misses even when the sync-idle reports failure', async () => {
    onInvoke('library_resolve_artist_ids', async () => [null]);
    await resolveArtistIdsByName('s1', ['Guest']);
    expect(peekArtistIdByName('s1', 'Guest')).toBeNull();

    onInvoke('library_sync_start', async (args: unknown) => {
      const { serverId } = args as { serverId: string };
      queueMicrotask(() =>
        emitTauriEvent('library:sync-idle', {
          serverId,
          libraryScope: '',
          kind: 'initial_sync',
          jobId: 'j-fail',
          ok: false,
          error: 'boom',
        }),
      );
      return { jobId: 'j-fail', serverId, kind: 'initial_sync' };
    });
    await expect(enqueueLibrarySync({ serverId: 's1', kind: 'full' })).rejects.toThrow('boom');

    expect(peekArtistIdByName('s1', 'Guest')).toBeUndefined();
  });

  it('routes verify through library_sync_verify_integrity', async () => {
    const verify = vi.fn(async (args: unknown) => {
      const { serverId } = args as { serverId: string };
      queueMicrotask(() =>
        emitTauriEvent('library:sync-idle', {
          serverId,
          libraryScope: '',
          kind: 'delta_sync',
          jobId: 'v1',
          ok: true,
        }),
      );
      return { jobId: 'v1', serverId, kind: 'delta_sync' };
    });
    onInvoke('library_sync_verify_integrity', verify);

    await enqueueLibrarySync({ serverId: 's1', kind: 'verify' });

    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('coalesces weaker work behind a queued full sync', async () => {
    const start = vi.fn(async (args: unknown) => {
      const { serverId } = args as { serverId: string };
      return { jobId: 'j1', serverId, kind: 'initial_sync' };
    });
    onInvoke('library_sync_start', start);

    const full = enqueueLibrarySync({ serverId: 's1', kind: 'full' });
    const delta = enqueueLibrarySync({ serverId: 's1', kind: 'delta' });
    const verify = enqueueLibrarySync({ serverId: 's1', kind: 'verify' });
    expect(delta).toBe(full);
    expect(verify).toBe(full);
    expect(hasLibrarySyncWork('s1')).toBe(true);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    emitTauriEvent('library:sync-idle', {
      serverId: 's1', libraryScope: '', kind: 'initial_sync', jobId: 'j1', ok: true,
    });
    await Promise.all([full, delta, verify]);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ mode: 'full' }));
  });

  it('upgrades queued work in reverse order so full is never swallowed', async () => {
    const start = vi.fn(async (args: unknown) => {
      const { serverId } = args as { serverId: string };
      return { jobId: `j-${serverId}`, serverId, kind: 'initial_sync' };
    });
    onInvoke('library_sync_start', start);

    const blocker = enqueueLibrarySync({ serverId: 'blocker', kind: 'delta' });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const delta = enqueueLibrarySync({ serverId: 's1', kind: 'delta' });
    const verify = enqueueLibrarySync({ serverId: 's1', kind: 'verify' });
    const full = enqueueLibrarySync({ serverId: 's1', kind: 'full' });
    expect(verify).toBe(delta);
    expect(full).toBe(delta);

    emitTauriEvent('library:sync-idle', {
      serverId: 'blocker', libraryScope: '', kind: 'delta_sync', jobId: 'j-blocker', ok: true,
    });
    await blocker;
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({
      serverId: 's1',
      mode: 'full',
    }));
    emitTauriEvent('library:sync-idle', {
      serverId: 's1', libraryScope: '', kind: 'initial_sync', jobId: 'j-s1', ok: true,
    });
    await Promise.all([delta, verify, full]);
  });

  it('queues one trailing full successor behind an active weaker job', async () => {
    const start = vi.fn(async (args: unknown) => {
      const { serverId } = args as { serverId: string };
      return { jobId: `j-${serverId}`, serverId, kind: 'initial_sync' };
    });
    onInvoke('library_sync_start', start);

    const activeDelta = enqueueLibrarySync({ serverId: 's1', kind: 'delta' });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const full = enqueueLibrarySync({ serverId: 's1', kind: 'full' });
    const duplicateFull = enqueueLibrarySync({ serverId: 's1', kind: 'full' });
    expect(full).not.toBe(activeDelta);
    expect(duplicateFull).toBe(full);

    emitTauriEvent('library:sync-idle', {
      serverId: 's1', libraryScope: '', kind: 'delta_sync', jobId: 'j-s1', ok: true,
    });
    await activeDelta;
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'full' }));
    emitTauriEvent('library:sync-idle', {
      serverId: 's1', libraryScope: '', kind: 'initial_sync', jobId: 'j-s1', ok: true,
    });
    await Promise.all([full, duplicateFull]);
  });

  it('lets verify supersede a queued delta without adding another job', async () => {
    const start = vi.fn(async (args: unknown) => {
      const { serverId } = args as { serverId: string };
      return { jobId: `j-${serverId}`, serverId, kind: 'delta_sync' };
    });
    onInvoke('library_sync_start', start);
    const verifyInvoke = vi.fn(async (args: unknown) => {
      const { serverId } = args as { serverId: string };
      return { jobId: `v-${serverId}`, serverId, kind: 'delta_sync' };
    });
    onInvoke('library_sync_verify_integrity', verifyInvoke);

    const blocker = enqueueLibrarySync({ serverId: 'blocker', kind: 'delta' });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const delta = enqueueLibrarySync({ serverId: 's1', kind: 'delta' });
    const verify = enqueueLibrarySync({ serverId: 's1', kind: 'verify' });
    expect(verify).toBe(delta);

    emitTauriEvent('library:sync-idle', {
      serverId: 'blocker', libraryScope: '', kind: 'delta_sync', jobId: 'j-blocker', ok: true,
    });
    await blocker;
    await vi.waitFor(() => expect(verifyInvoke).toHaveBeenCalledTimes(1));
    emitTauriEvent('library:sync-idle', {
      serverId: 's1', libraryScope: '', kind: 'delta_sync', jobId: 'v-s1', ok: true,
    });
    await Promise.all([delta, verify]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('clears pending work for one server without disturbing the active server', async () => {
    const start = vi.fn(async (args: unknown) => {
      const { serverId } = args as { serverId: string };
      return { jobId: `j-${serverId}`, serverId, kind: 'initial_sync' };
    });
    onInvoke('library_sync_start', start);

    const active = enqueueLibrarySync({ serverId: 'a', kind: 'full' });
    const pending = enqueueLibrarySync({ serverId: 'b', kind: 'full' });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(clearPendingLibrarySync('b')).toBe(1);
    await pending;
    expect(hasLibrarySyncWork('b')).toBe(false);

    emitTauriEvent('library:sync-idle', {
      serverId: 'a', libraryScope: '', kind: 'initial_sync', jobId: 'j-a', ok: true,
    });
    await active;
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('cancel cleanup removes a stronger trailing successor for the active server', async () => {
    const start = vi.fn(async (args: unknown) => {
      const { serverId } = args as { serverId: string };
      return { jobId: `j-${serverId}`, serverId, kind: 'delta_sync' };
    });
    onInvoke('library_sync_start', start);

    const active = enqueueLibrarySync({ serverId: 's1', kind: 'delta' });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const pendingFull = enqueueLibrarySync({ serverId: 's1', kind: 'full' });
    expect(clearPendingLibrarySync('s1')).toBe(1);
    await pendingFull;
    expect(hasLibrarySyncWork('s1', 'full')).toBe(false);

    emitTauriEvent('library:sync-idle', {
      serverId: 's1', libraryScope: '', kind: 'delta_sync', jobId: 'j-s1', ok: true,
    });
    await active;
    expect(start).toHaveBeenCalledTimes(1);
  });
});
