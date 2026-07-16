// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useRangeSelection } from '@/lib/hooks/useRangeSelection';

describe('useRangeSelection', () => {
  it('selects equal raw ids independently by server provenance', () => {
    const items = [
      { serverId: 'srv-a', id: 'same' },
      { serverId: 'srv-b', id: 'same' },
    ];
    const { result } = renderHook(() => useRangeSelection(items));

    act(() => result.current.toggleSelect('srv-a:same'));
    act(() => result.current.toggleSelect('srv-b:same'));

    expect(result.current.selectedIds).toEqual(new Set(['srv-a:same', 'srv-b:same']));
  });

  it('uses provenance-aware keys for shift ranges', () => {
    const items = [
      { serverId: 'srv-a', id: 'same' },
      { serverId: 'srv-b', id: 'same' },
      { serverId: 'srv-c', id: 'other' },
    ];
    const { result } = renderHook(() => useRangeSelection(items));

    act(() => result.current.toggleSelect('srv-a:same'));
    act(() => result.current.toggleSelect('srv-c:other', { shiftKey: true }));

    expect(result.current.selectedIds).toEqual(new Set([
      'srv-a:same',
      'srv-b:same',
      'srv-c:other',
    ]));
  });
});
