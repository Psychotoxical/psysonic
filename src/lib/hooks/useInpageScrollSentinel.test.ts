import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useInpageScrollSentinel } from '@/lib/hooks/useInpageScrollSentinel';

describe('useInpageScrollSentinel', () => {
  it('returns a callback ref function', () => {
    const onIntersect = vi.fn();
    const { result } = renderHook(() =>
      useInpageScrollSentinel({
        active: true,
        onIntersect,
      }),
    );
    expect(typeof result.current).toBe('function');
  });
});
