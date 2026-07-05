import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { registerOrbitRuntime } from '@/store/orbitRuntime';
import { makeTracks } from '@/test/helpers/factories';
import { resetAllStores } from '@/test/helpers/storeReset';

// Scenario: orbit session × bulk enqueue. The real `enqueue` action routes a
// multi-track enqueue through the orbitRuntime.bulkGuard seam and only commits the
// tracks when the guard resolves true; a single track bypasses the guard entirely.
// We inject a fake runtime and assert the observable queue outcome.

const flush = () => new Promise((r) => setTimeout(r, 0));

let bulkGuard: Mock<(count: number) => Promise<boolean>>;

beforeEach(() => {
  resetAllStores();
  bulkGuard = vi.fn<(count: number) => Promise<boolean>>(async () => true);
  registerOrbitRuntime({
    getSnapshot: () => ({ role: 'host', phase: 'active', state: null }),
    bulkGuard,
  });
});

describe('orbit session × bulk enqueue', () => {
  it('over-threshold + guard accepts → tracks enqueued', async () => {
    bulkGuard.mockResolvedValue(true);
    usePlayerStore.getState().enqueue(makeTracks(2));
    await flush();
    expect(bulkGuard).toHaveBeenCalledWith(2);
    expect(usePlayerStore.getState().queueItems).toHaveLength(2);
  });

  it('over-threshold + guard rejects → nothing enqueued', async () => {
    bulkGuard.mockResolvedValue(false);
    usePlayerStore.getState().enqueue(makeTracks(2));
    await flush();
    expect(bulkGuard).toHaveBeenCalledWith(2);
    expect(usePlayerStore.getState().queueItems).toHaveLength(0);
  });

  it('single track bypasses the guard and enqueues directly', async () => {
    usePlayerStore.getState().enqueue(makeTracks(1));
    await flush();
    expect(bulkGuard).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().queueItems).toHaveLength(1);
  });
});
