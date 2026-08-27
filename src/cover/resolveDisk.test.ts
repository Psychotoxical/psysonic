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

const ref = albumCoverRef('al-1', 'al-1-real');

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
      pathVersion: 1787826019,
      path: 'C:/cc/srv/album/al-1/512.webp',
      tier: 2000,
    });
    expect(await ensureCoverTierDiskSrc(ref, 2000)).toBe('');
  });

  it('accepts an exact-tier hit on either path separator', async () => {
    vi.mocked(coverCacheEnsure).mockResolvedValue({
      hit: true,
      pathVersion: 1787826019,
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

describe('ensureCoverTierDiskSrc — chain ladder serve (coverless _0 album)', () => {
  const coverlessRef = albumCoverRef('al-2', 'al-2_0');

  beforeEach(() => {
    vi.mocked(coverCacheEnsure).mockReset();
    vi.mocked(getDiskSrc).mockReset().mockReturnValue('');
    vi.mocked(rememberDiskSrc).mockReset().mockImplementation((_k, p) => `asset://${p}`);
  });

  it('accepts the chain-ladder serve for a coverless album at full-res', async () => {
    // Rust `chain_hit_fullres_redirect` serves the chain's best ladder tier
    // (e.g. 800.webp) for a tier-2000 request on a marker-present coverless
    // album. Rejecting it sent the lightbox to a raw Navidrome URL — the vinyl
    // placeholder. The serve is real art; take it.
    vi.mocked(coverCacheEnsure).mockResolvedValue({
      hit: true,
      pathVersion: 1787826019,
      path: '/cc/srv/album/al-2/800.webp',
      tier: 2000,
    });
    expect(await ensureCoverTierDiskSrc(coverlessRef, 2000)).toBe(
      'asset:///cc/srv/album/al-2/800.webp',
    );
  });

  it('keeps exact-tier discipline for coverless albums at display tiers', async () => {
    // Below 2000 the guard must not relax: a 512 request answered with a
    // 256 file is still a downgrade, not a chain serve.
    vi.mocked(coverCacheEnsure).mockResolvedValue({
      hit: true,
      pathVersion: 1787826019,
      path: '/cc/srv/album/al-2/256.webp',
      tier: 512,
    });
    expect(await ensureCoverTierDiskSrc(coverlessRef, 512)).toBe('');
  });

  it('keeps exact-tier discipline for non-coverless albums at full-res', async () => {
    // A real (non-`_0`) album's 2000.webp is genuine server art; a smaller
    // serve is a downgrade and must stay rejected.
    vi.mocked(coverCacheEnsure).mockResolvedValue({
      hit: true,
      pathVersion: 1787826019,
      path: '/cc/srv/album/al-1/800.webp',
      tier: 2000,
    });
    expect(await ensureCoverTierDiskSrc(ref, 2000)).toBe('');
  });
});
