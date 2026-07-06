import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/cover/imageCache', () => ({ getCachedBlob: vi.fn() }));
vi.mock('@/lib/dom/dynamicColors', () => ({ extractCoverColors: vi.fn() }));

import { getCachedBlob } from '@/cover/imageCache';
import { extractCoverColors } from '@/lib/dom/dynamicColors';
import { useFsDynamicAccent } from './useFsDynamicAccent';

const blob = () => new Blob(['x'], { type: 'image/webp' });
const accent = (hex: string) => vi.mocked(extractCoverColors).mockResolvedValue({ accent: hex } as never);

beforeAll(() => {
  // jsdom has no object-URL support.
  global.URL.createObjectURL = vi.fn(() => 'blob:mock');
  global.URL.revokeObjectURL = vi.fn();
});

afterEach(() => vi.clearAllMocks());

describe('useFsDynamicAccent', () => {
  it('returns null and does no work when there is no cover art', () => {
    const { result } = renderHook(() => useFsDynamicAccent('', ''));
    expect(result.current).toBeNull();
    expect(getCachedBlob).not.toHaveBeenCalled();
  });

  it('extracts the accent from the cover on a cache miss', async () => {
    vi.mocked(getCachedBlob).mockResolvedValue(blob());
    accent('#abcdef');
    const { result } = renderHook(() => useFsDynamicAccent('http://x/cover', 'key-A'));
    await waitFor(() => expect(result.current).toBe('#abcdef'));
    expect(getCachedBlob).toHaveBeenCalledWith('http://x/cover', 'key-A');
  });

  it('re-runs extraction when the cover src resolves AFTER the cacheKey (async-src fix)', async () => {
    vi.mocked(getCachedBlob).mockResolvedValue(blob());
    accent('#112233');
    // First render: cacheKey is set but src is still empty → nothing extracted.
    const { result, rerender } = renderHook(
      ({ url, key }: { url: string; key: string }) => useFsDynamicAccent(url, key),
      { initialProps: { url: '', key: 'key-B' } },
    );
    expect(result.current).toBeNull();
    expect(getCachedBlob).not.toHaveBeenCalled();
    // The async src arrives on a later render (same key) → extraction must fire.
    rerender({ url: 'http://x/cover', key: 'key-B' });
    await waitFor(() => expect(result.current).toBe('#112233'));
  });

  it('serves a same-key remount from the module cache without re-fetching', async () => {
    vi.mocked(getCachedBlob).mockResolvedValue(blob());
    accent('#445566');
    const first = renderHook(() => useFsDynamicAccent('http://x/c', 'key-C'));
    await waitFor(() => expect(first.result.current).toBe('#445566'));
    vi.mocked(getCachedBlob).mockClear();
    const second = renderHook(() => useFsDynamicAccent('http://x/c', 'key-C'));
    expect(second.result.current).toBe('#445566');
    expect(getCachedBlob).not.toHaveBeenCalled();
  });

  it('leaves the accent unset when extraction yields no colour', async () => {
    vi.mocked(getCachedBlob).mockResolvedValue(blob());
    vi.mocked(extractCoverColors).mockResolvedValue({ accent: undefined } as never);
    const { result } = renderHook(() => useFsDynamicAccent('http://x/d', 'key-D'));
    await waitFor(() => expect(getCachedBlob).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});
