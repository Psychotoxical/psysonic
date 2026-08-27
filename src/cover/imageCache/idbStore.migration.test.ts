import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { putBlob, scheduleEvictDiskIfNeeded } from '@/cover/imageCache/idbStore';
import { NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY } from '@/lib/server/navidromeCanonicalCheckpointStatus';

describe('cover IDB canonical migration fence', () => {
  beforeEach(() => localStorage.removeItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not start a cover write while the bootstrap lock is active', async () => {
    const open = vi.fn();
    vi.stubGlobal('indexedDB', { open });
    localStorage.setItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY, '1');
    await putBlob('migration-fence', new Blob(['legacy']));

    expect(open).not.toHaveBeenCalled();
  });

  it('does not run a previously scheduled eviction after the lock activates', async () => {
    vi.useFakeTimers();
    const open = vi.fn();
    vi.stubGlobal('indexedDB', { open });
    scheduleEvictDiskIfNeeded(1);
    localStorage.setItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY, '1');

    await vi.advanceTimersByTimeAsync(500);

    expect(open).not.toHaveBeenCalled();
  });
});
