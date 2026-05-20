import { describe, it, expect, vi } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { resumeInitialSyncIfIncomplete } from './librarySession';

const status = (over: Record<string, unknown> = {}) => ({
  serverId: 's1',
  libraryScope: '',
  syncPhase: 'idle',
  capabilityFlags: 0,
  libraryTier: 'unknown',
  syncedAt: 0,
  ...over,
});

describe('resumeInitialSyncIfIncomplete', () => {
  it('starts a full sync when no full sync has completed', async () => {
    onInvoke('library_get_status', () => status()); // no lastFullSyncAt
    const start = vi.fn(() => ({ jobId: 'j1', serverId: 's1', kind: 'initial_sync' }));
    onInvoke('library_sync_start', start);

    await resumeInitialSyncIfIncomplete('s1');

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 's1', mode: 'full' }),
    );
  });

  it('does nothing when a full sync has already completed', async () => {
    onInvoke('library_get_status', () => status({ syncPhase: 'ready', lastFullSyncAt: 1_716_000_000_000 }));
    const start = vi.fn();
    onInvoke('library_sync_start', start);

    await resumeInitialSyncIfIncomplete('s1');

    expect(start).not.toHaveBeenCalled();
  });

  it('de-dupes concurrent calls so a second start cannot cancel the first', async () => {
    onInvoke('library_get_status', () => status()); // incomplete
    const start = vi.fn(() => ({ jobId: 'j1', serverId: 's1', kind: 'initial_sync' }));
    onInvoke('library_sync_start', start);

    // Two near-simultaneous calls (StrictMode double-fires the startup effect).
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
