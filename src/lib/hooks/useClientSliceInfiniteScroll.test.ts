import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useClientSliceInfiniteScroll } from '@/lib/hooks/useClientSliceInfiniteScroll';

vi.mock('@/lib/hooks/useInpageScrollSentinel', () => ({
  useInpageScrollSentinel: () => vi.fn(),
}));

describe('useClientSliceInfiniteScroll', () => {
  it('grows visibleCount by pageSize and clears loadingMore', () => {
    const { result, rerender } = renderHook(
      ({ filter }: { filter: string }) =>
        useClientSliceInfiniteScroll({
          pageSize: 50,
          resetDeps: [filter],
        }),
      { initialProps: { filter: '' } },
    );

    expect(result.current.visibleCount).toBe(50);

    act(() => {
      result.current.loadMore();
    });
    expect(result.current.visibleCount).toBe(100);

    rerender({ filter: 'a' });
    expect(result.current.visibleCount).toBe(50);
    expect(result.current.loadingMore).toBe(false);
  });
});
