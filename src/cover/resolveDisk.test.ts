import { describe, expect, it, vi, beforeEach } from 'vitest';
import { albumCoverRef } from './ref';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@/lib/api/coverCache', () => ({ coverCacheEnsure: vi.fn() }));
vi.mock('./imageCache', () => ({ invalidateCacheKey: vi.fn() }));
vi.mock('./diskSrcCache', () => ({
  getDiskSrc: vi.fn(() => ''),
  rememberDiskSrc: vi.fn((_key: string, path: string) => `asset://${path}`),
}));

import { ensureCoverTierDiskSrc } from './resolveDisk';
import { coverCacheEnsure } from '@/lib/api/coverCache';
import { getDiskSrc, rememberDiskSrc } from './diskSrcCache';

const ref = albumCoverRef('al-1', 'al-1');

describe('ensureCoverTierDiskSrc — full-res exact-tier guard', () => {
  beforeEach(() => {
    vi.mocked(coverCacheEnsure).mockReset();
    vi.mocked(getDiskSrc).mockReset().mockReturnValue('');
    vi.mocked(rememberDiskSrc).mockReset().mockImplementation((_k, p) => `asset://${p}`);
  });

  it('rejects a backend hit that served a smaller tier than requested', async () => {
    // The Rust peek can report a hit with a smaller tier's file for a full-res
    // request — the lightbox must treat that as a miss so it can fetch full-res.
    vi.mocked(coverCacheEnsure).mockResolvedValue({
      hit: true,
      path: 'C:/cc/srv/album/al-1/512.webp',
      tier: 2000,
    });
    expect(await ensureCoverTierDiskSrc(ref, 2000)).toBe('');
  });

  it('accepts an exact-tier hit on either path separator', async () => {
    vi.mocked(coverCacheEnsure).mockResolvedValue({
      hit: true,
      path: 'C:\\cc\\srv\\album\\al-1\\2000.webp',
      tier: 2000,
    });
    expect(await ensureCoverTierDiskSrc(ref, 2000)).toBe(
      'asset://C:\\cc\\srv\\album\\al-1\\2000.webp',
    );
  });

  it('returns an exact in-memory hit without calling the backend', async () => {
    vi.mocked(getDiskSrc).mockReturnValue('asset://cached-2000');
    expect(await ensureCoverTierDiskSrc(ref, 2000)).toBe('asset://cached-2000');
    expect(coverCacheEnsure).not.toHaveBeenCalled();
  });
});
