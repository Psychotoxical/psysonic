import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAsyncInpagePagination } from '@/lib/hooks/useAsyncInpagePagination';

describe('useAsyncInpagePagination', () => {
  it('blocks concurrent page requests', async () => {
    let resolveLoad: (() => void) | undefined;
    const onPage = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveLoad = resolve;
        }),
    );

    const { result } = renderHook(() => useAsyncInpagePagination(30));

    act(() => {
      expect(result.current.requestNextPage(onPage)).toBe(true);
      expect(result.current.requestNextPage(onPage)).toBe(false);
    });

    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledWith(30);

    await act(async () => {
      resolveLoad?.();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.page).toBe(1);
  });

  it('resetPage clears guards and page index', () => {
    const { result } = renderHook(() => useAsyncInpagePagination(30));

    act(() => {
      result.current.pageRef.current = 3;
      result.current.loadPendingRef.current = true;
      result.current.setPage(3);
      result.current.resetPage();
    });

    expect(result.current.page).toBe(0);
    expect(result.current.pageRef.current).toBe(0);
    expect(result.current.loadPendingRef.current).toBe(false);
  });
});
