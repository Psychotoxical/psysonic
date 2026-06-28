import { describe, expect, it, vi, beforeEach } from 'vitest';
import { albumCoverRef } from './ref';

vi.mock('./diskSrcCache', () => ({
  rememberDiskSrc: vi.fn(() => 'asset://cover.webp'),
  getDiskSrc: vi.fn(() => ''),
}));

vi.mock('./diskHandoff', () => ({
  hasCoverDiskReadyListeners: vi.fn(() => true),
  notifyCoverDiskReady: vi.fn(),
}));

import { rememberDiskSrc } from './diskSrcCache';
import { notifyCoverDiskReady } from './diskHandoff';
import { gridDiskSrcLookupOrder, rememberDiskSrcLadder, rememberGridDiskSrc } from './diskSrcLookup';

describe('gridDiskSrcLookupOrder', () => {
  it('prefers 800 right after 512 when 512 is wanted', () => {
    expect(gridDiskSrcLookupOrder(512)).toEqual([512, 800, 256, 128]);
  });

  it('prefers 800 for 256 display tier', () => {
    expect(gridDiskSrcLookupOrder(256)[1]).toBe(800);
  });
});

describe('rememberGridDiskSrc', () => {
  beforeEach(() => {
    vi.mocked(rememberDiskSrc).mockClear();
    vi.mocked(notifyCoverDiskReady).mockClear();
    vi.mocked(rememberDiskSrc).mockReturnValue('asset://x');
  });

  it('seeds 512 and 800 keys from one on-disk path (800.webp fallback)', () => {
    const ref = albumCoverRef('al-1', 'al-1');
    const hit = rememberGridDiskSrc(ref, 512, '/data/800.webp');
    expect(hit).toBe(true);
    expect(vi.mocked(rememberDiskSrc).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(vi.mocked(notifyCoverDiskReady)).toHaveBeenCalledTimes(1);
  });
});

describe('rememberDiskSrcLadder', () => {
  beforeEach(() => {
    vi.mocked(rememberDiskSrc).mockClear();
    vi.mocked(rememberDiskSrc).mockReturnValue('asset://x');
  });

  it('seeds 128 when only 800.webp path arrives', () => {
    const hit = rememberDiskSrcLadder('srv', { cacheKind: 'album', cacheEntityId: 'al-1' }, 128, '/data/800.webp');
    expect(hit).toBe(true);
    const keys = vi.mocked(rememberDiskSrc).mock.calls.map(c => c[0]);
    expect(keys).toContain('srv:cover:album:al-1:128');
    expect(keys).toContain('srv:cover:album:al-1:800');
  });
});

describe('full-res (2000) seed guard', () => {
  beforeEach(() => {
    vi.mocked(rememberDiskSrc).mockClear();
    vi.mocked(rememberDiskSrc).mockReturnValue('asset://x');
  });

  it('never seeds the 2000 key from a smaller tier file', () => {
    const ref = albumCoverRef('al-1', 'al-1');
    rememberGridDiskSrc(ref, 2000, '/data/512.webp');
    const keys = vi.mocked(rememberDiskSrc).mock.calls.map(c => c[0]);
    expect(keys.some(k => k.endsWith(':2000'))).toBe(false);
    // Smaller display keys are still seeded.
    expect(keys.some(k => k.endsWith(':512'))).toBe(true);
  });

  it('seeds the 2000 key from a real 2000 file', () => {
    const ref = albumCoverRef('al-1', 'al-1');
    rememberGridDiskSrc(ref, 2000, '/data/2000.webp');
    const keys = vi.mocked(rememberDiskSrc).mock.calls.map(c => c[0]);
    expect(keys.some(k => k.endsWith(':2000'))).toBe(true);
  });
});
