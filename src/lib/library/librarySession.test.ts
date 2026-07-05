import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emitTauriEvent, onInvoke } from '@/test/mocks/tauri';
import { resumeInitialSyncIfIncomplete } from './librarySession';
import { resetLibrarySyncQueueForTests } from './librarySyncQueue';

const status = (over: Record<string, unknown> = {}) => ({
  serverId: 's1',
  libraryScope: '',
  syncPhase: 'idle',
  capabilityFlags: 0,
  libraryTier: 'unknown',
  syncedAt: 0,
  ...over,
});

function mockQueuedStart() {
  const start = vi.fn(async (args: unknown) => {
    const { serverId } = args as { serverId: string };
    queueMicrotask(() =>
      emitTauriEvent('library:sync-idle', {
        serverId,
        libraryScope: '',
        kind: 'initial_sync',
        ok: true,
      }),
    );
    return { jobId: 'j1', serverId, kind: 'initial_sync' };
  });
  onInvoke('library_sync_start', start);
  return start;
}

describe('resumeInitialSyncIfIncomplete', () => {
  beforeEach(() => {
    resetLibrarySyncQueueForTests();
  });

  it('resumes when initial sync was interrupted mid-run', async () => {
    onInvoke('library_get_status', () => status({ syncPhase: 'initial_sync' }));
    const start = mockQueuedStart();

    await resumeInitialSyncIfIncomplete('s1');

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 's1', mode: 'full' }),
    );
  });

  it('does not restart when idle with a completed index (legacy missing lastFullSyncAt)', async () => {
    onInvoke('library_get_status', () =>
      status({ syncPhase: 'idle', localTrackCount: 12_000 }),
    );
    const start = vi.fn();
    onInvoke('library_sync_start', start);

    await resumeInitialSyncIfIncomplete('s1');

    expect(start).not.toHaveBeenCalled();
  });

  it('does nothing when a full sync has already completed', async () => {
    onInvoke('library_get_status', () => status({ syncPhase: 'ready', lastFullSyncAt: 1_716_000_000_000 }));
    const start = vi.fn();
    onInvoke('library_sync_start', start);

    await resumeInitialSyncIfIncomplete('s1');

    expect(start).not.toHaveBeenCalled();
  });

  it('de-dupes concurrent calls so a second start cannot cancel the first', async () => {
    onInvoke('library_get_status', () => status({ syncPhase: 'initial_sync' }));
    const start = mockQueuedStart();

    await Promise.all([
      resumeInitialSyncIfIncomplete('s1'),
      resumeInitialSyncIfIncomplete('s1'),
    ]);

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the status lookup fails', async () => {
    onInvoke('library_get_status', () => { throw new Error('boom'); });
    const start = vi.fn();
    onInvoke('library_sync_start', start);

    await expect(resumeInitialSyncIfIncomplete('s1')).resolves.toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });
});
