import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { albumCoverRef } from './ref';

vi.mock('./resolveDisk', () => ({ ensureCoverTierDiskSrc: vi.fn() }));
vi.mock('./diskSrcLookup', () => ({ getDiskSrcForGrid: vi.fn(() => '') }));
vi.mock('./fetchUrl', () => ({ buildCoverArtFetchUrl: vi.fn(() => 'net://2000') }));
vi.mock('./imgSrc', () => ({ coverImgSrc: (s: string) => s }));
vi.mock('@/ui/CoverLightbox', () => ({ default: () => null }));

import { useCoverLightboxSrc } from './lightbox';
import { ensureCoverTierDiskSrc } from './resolveDisk';
import { getDiskSrcForGrid } from './diskSrcLookup';

const ref = albumCoverRef('al-1', 'al-1');

describe('useCoverLightboxSrc — full-res opening race', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(ensureCoverTierDiskSrc).mockReset();
    vi.mocked(getDiskSrcForGrid).mockReset().mockReturnValue('');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows full-res 2000 when the ensure resolves within the window', async () => {
    vi.mocked(ensureCoverTierDiskSrc).mockResolvedValue('asset://2000');
    const { result } = renderHook(() => useCoverLightboxSrc(ref));
    act(() => result.current.open());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.src).toBe('asset://2000');
  });

  it('falls back to the warm 800 tier when 2000 is not ready within 500ms', async () => {
    // 2000 ensure never resolves in time.
    vi.mocked(ensureCoverTierDiskSrc).mockReturnValue(new Promise<string>(() => {}));
    vi.mocked(getDiskSrcForGrid).mockReturnValue('asset://800');
    const { result } = renderHook(() => useCoverLightboxSrc(ref));
    act(() => result.current.open());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.src).toBe('asset://800');
  });

  it('falls back to the network full-res url when no warm tier is cached', async () => {
    vi.mocked(ensureCoverTierDiskSrc).mockReturnValue(new Promise<string>(() => {}));
    vi.mocked(getDiskSrcForGrid).mockReturnValue('');
    const { result } = renderHook(() => useCoverLightboxSrc(ref));
    act(() => result.current.open());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.src).toBe('net://2000');
  });
});
