import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDiscSeparatorCoverRef } from './useDiscSeparatorCoverRef';
import * as serverReachability from '@/lib/network/serverReachability';

const discSong = {
  id: 't1',
  albumId: 'al-1',
  coverArt: 'mf-a',
  discNumber: 1,
  serverId: 's1',
};

const bareSong = {
  id: 't1',
  albumId: 'al-1',
  coverArt: undefined,
  discNumber: 1,
  serverId: 's1',
};

function mockUnavailable(value: boolean) {
  return vi.spyOn(serverReachability, 'useServerUnavailable').mockReturnValue(value);
}

describe('useDiscSeparatorCoverRef', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the disc-specific slot while the owning server is reachable', () => {
    mockUnavailable(false);
    const { result } = renderHook(() => useDiscSeparatorCoverRef(discSong));
    expect(result.current?.cacheEntityId).toBe('mf-a');
    expect(result.current?.fetchCoverArtId).toBe('mf-a');
  });

  it('falls back to the shared album cover when the server is known-unreachable', () => {
    mockUnavailable(true);
    const { result } = renderHook(() => useDiscSeparatorCoverRef(discSong));
    expect(result.current?.cacheEntityId).toBe('al-1');
    expect(result.current?.cacheEntityId).not.toBe('mf-a');
  });

  it('never falls back for a track with no disc-specific cover', () => {
    mockUnavailable(true);
    const { result } = renderHook(() => useDiscSeparatorCoverRef(bareSong));
    expect(result.current?.cacheEntityId).toBe('al-1');
    expect(result.current?.fetchCoverArtId).toBe('al-al-1_0');
  });

  it('upgrades back to the disc-specific slot when the server becomes reachable', () => {
    const spy = mockUnavailable(true);
    const { result, rerender } = renderHook(() => useDiscSeparatorCoverRef(discSong));
    expect(result.current?.cacheEntityId).toBe('al-1');
    spy.mockReturnValue(false);
    rerender();
    expect(result.current?.cacheEntityId).toBe('mf-a');
  });

  it('subscribes to reachability for its own server id only', () => {
    const spy = mockUnavailable(false);
    renderHook(() => useDiscSeparatorCoverRef(discSong));
    expect(spy).toHaveBeenCalledWith('s1');
  });

  it('returns a stable ref object across re-renders with unchanged inputs', () => {
    mockUnavailable(false);
    const { result, rerender } = renderHook(() => useDiscSeparatorCoverRef(discSong));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
