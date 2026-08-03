import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  resolveArtistIds: vi.fn(),
}));

vi.mock('@/generated/bindings', () => ({
  commands: { libraryResolveArtistIds: hoisted.resolveArtistIds },
}));
vi.mock('@/lib/api/coverCache', () => ({
  librarySqlServerId: (id: string) => id,
}));

import { useResolvedArtistRefs } from '@/lib/hooks/useResolvedArtistRefs';
import {
  __resetArtistIdResolveCacheForTests,
  clearArtistIdResolveCache,
} from '@/lib/library/artistIdResolve';

/** Stable identity: the hook re-resolves on the set of names, not on array identity. */
const REFS = [{ name: 'Alice' }];

describe('useResolvedArtistRefs', () => {
  beforeEach(() => {
    __resetArtistIdResolveCacheForTests();
    hoisted.resolveArtistIds.mockReset();
  });

  it('fills in the id of a split credit and leaves structured refs untouched', async () => {
    hoisted.resolveArtistIds.mockResolvedValue({ status: 'ok', data: ['ar-a'] });
    const refs = [{ id: 'ar-known', name: 'Bob' }, { name: 'Alice' }];

    const { result } = renderHook(() => useResolvedArtistRefs(refs, 'srv'));
    await act(async () => {});

    expect(hoisted.resolveArtistIds).toHaveBeenCalledWith('srv', ['Alice']);
    expect(result.current[0].id).toBe('ar-known');
    expect(result.current[1].id).toBe('ar-a');
  });

  // A sync that lands mid-lookup retires the answer in flight. The row stays mounted
  // and has already re-joined that very batch, so nothing else would tell it to ask
  // again — it would render its credit as plain text until it unmounts.
  it('re-resolves a mounted row whose lookup a cache clear retired', async () => {
    vi.useFakeTimers();
    try {
      let release: (value: unknown) => void = () => {};
      hoisted.resolveArtistIds.mockReturnValueOnce(
        new Promise(resolve => { release = resolve; }),
      );

      const { result } = renderHook(() => useResolvedArtistRefs(REFS, 'srv'));
      await act(async () => {});
      expect(hoisted.resolveArtistIds).toHaveBeenCalledTimes(1);

      await act(async () => { clearArtistIdResolveCache(); });
      await act(async () => { release({ status: 'ok', data: ['ar-a'] }); });

      // The pre-clear answer is correctly discarded, so the credit is still id-less.
      expect(result.current[0].id).toBeUndefined();
      expect(hoisted.resolveArtistIds).toHaveBeenCalledTimes(1);

      hoisted.resolveArtistIds.mockResolvedValue({ status: 'ok', data: ['ar-a'] });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

      expect(hoisted.resolveArtistIds).toHaveBeenCalledTimes(2);
      expect(result.current[0].id).toBe('ar-a');
    } finally {
      vi.useRealTimers();
    }
  });
});
