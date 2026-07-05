import { describe, expect, it, vi, beforeEach } from 'vitest';

const { ensureImpl } = vi.hoisted(() => ({
  ensureImpl: vi.fn(
    async (ref: { fetchCoverArtId: string }, _tier: number, _priority: string) => {
      await new Promise(r => setTimeout(r, 2));
      return { hit: true, path: `/tmp/${ref.fetchCoverArtId}.webp`, tier: 128 };
    },
  ),
}));

vi.mock('@/lib/api/coverCache', () => ({
  coverCacheEnsure: ensureImpl,
  libraryCoverBackfillConfigure: vi.fn(async () => {}),
  libraryCoverBackfillSetUiPriority: vi.fn(async () => {}),
}));

import { coverArtRef } from './ref';
import {
  __test_resetCoverTraffic,
  coverTrafficBeginServerSwitch,
  coverTrafficEndServerSwitch,
} from './coverTraffic';
import {
  __test_queuedCoverIds,
  __test_resetCoverEnsureQueue,
  coverEnsureBump,
  coverEnsureQueued,
  coverEnsureRelease,
  coverEnsureReprioritize,
  coverEnsureQueueStats,
} from './ensureQueue';

describe('coverEnsureQueued', () => {
  beforeEach(() => {
    __test_resetCoverEnsureQueue();
    __test_resetCoverTraffic();
    ensureImpl.mockClear();
    ensureImpl.mockImplementation(
      async (ref: { fetchCoverArtId: string }, _tier: number, _priority: string) => {
        await new Promise(r => setTimeout(r, 2));
        return { hit: true, path: `/tmp/${ref.fetchCoverArtId}.webp`, tier: 128 };
      },
    );
  });

  it('dedupes concurrent ensures for the same storage key', async () => {
    const ref = coverArtRef('al-1');
    const [a, b] = await Promise.all([
      coverEnsureQueued('s:cover:al-1:128', ref, 128, 'high'),
      coverEnsureQueued('s:cover:al-1:128', ref, 128, 'low'),
    ]);
    expect(a.path).toBe('/tmp/al-1.webp');
    expect(b.path).toBe('/tmp/al-1.webp');
    expect(ensureImpl).toHaveBeenCalledTimes(1);
  });

  it('bumps a queued job ahead of older high-priority work', () => {
    coverTrafficBeginServerSwitch();
    const refA = coverArtRef('al-a');
    const refB = coverArtRef('al-b');
    const refC = coverArtRef('al-c');

    void coverEnsureQueued('s:cover:al-a:128', refA, 128, 'high');
    void coverEnsureQueued('s:cover:al-b:128', refB, 128, 'high');
    void coverEnsureQueued('s:cover:al-c:128', refC, 128, 'high');
    coverEnsureBump('s:cover:al-c:128', 'high');

    expect(__test_queuedCoverIds()[0]).toBe('al-c');
    coverTrafficEndServerSwitch();
  });

  it('reprioritize downgrades viewport-leavers to middle with LIFO order', () => {
    coverTrafficBeginServerSwitch();
    const refNear = coverArtRef('al-near');
    const refFar = coverArtRef('al-far');

    void coverEnsureQueued('s:cover:al-near:128', refNear, 128, 'high');
    void coverEnsureQueued('s:cover:al-far:128', refFar, 128, 'high');
    coverEnsureReprioritize('s:cover:al-near:128', 'middle');
    coverEnsureReprioritize('s:cover:al-far:128', 'middle');

    const stats = coverEnsureQueueStats();
    expect(stats.queuedHigh).toBe(0);
    expect(stats.queuedMiddle).toBe(2);
    expect(__test_queuedCoverIds()[0]).toBe('al-far');
    coverTrafficEndServerSwitch();
  });

  it('shares one invoke slot per cover art id while duplicate jobs wait', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    ensureImpl.mockImplementationOnce(async () => {
      await gate;
      return { hit: true, path: '/tmp/al-shared.webp', tier: 128 };
    });

    const ref = coverArtRef('al-shared');
    void coverEnsureQueued('s:cover:al-shared:128', ref, 128, 'high');
    void coverEnsureQueued('s:cover:al-shared:256', ref, 256, 'high');

    await new Promise(r => setTimeout(r, 10));
    expect(ensureImpl).toHaveBeenCalledTimes(1);
    expect(coverEnsureQueueStats().inflight).toBe(1);

    release();
    await new Promise(r => setTimeout(r, 10));
  });

  it('release drops a pending job so a remount can re-queue', async () => {
    coverTrafficBeginServerSwitch();
    const ref = coverArtRef('al-drop');
    const pending = coverEnsureQueued('s:cover:al-drop:128', ref, 128, 'middle');
    coverEnsureRelease('s:cover:al-drop:128');
    const result = await pending;
    expect(result.path).toBe('');
    expect(ensureImpl).not.toHaveBeenCalled();

    coverTrafficEndServerSwitch();
    await new Promise(r => setTimeout(r, 800));

    await coverEnsureQueued('s:cover:al-drop:128', ref, 128, 'high');
    expect(ensureImpl).toHaveBeenCalledTimes(1);
  });
});
