import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emitTauriEvent, onInvoke } from '@/test/mocks/tauri';
import {
  enqueueLibrarySync,
  resetLibrarySyncQueueForTests,
} from './librarySyncQueue';

function mockSyncStart() {
  const start = vi.fn(async (args: unknown) => {
    const { serverId } = args as { serverId: string; mode: string };
    queueMicrotask(() =>
      emitTauriEvent('library:sync-idle', {
        serverId,
        libraryScope: '',
        kind: 'initial_sync',
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

  it('routes verify through library_sync_verify_integrity', async () => {
    const verify = vi.fn(async (args: unknown) => {
      const { serverId } = args as { serverId: string };
      queueMicrotask(() =>
        emitTauriEvent('library:sync-idle', {
          serverId,
          libraryScope: '',
          kind: 'delta_sync',
          ok: true,
        }),
      );
      return { jobId: 'v1', serverId, kind: 'delta_sync' };
    });
    onInvoke('library_sync_verify_integrity', verify);

    await enqueueLibrarySync({ serverId: 's1', kind: 'verify' });

    expect(verify).toHaveBeenCalledTimes(1);
  });
});
