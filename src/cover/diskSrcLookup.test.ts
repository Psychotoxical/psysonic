import { describe, expect, it, vi, beforeEach } from 'vitest';

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
import { gridDiskSrcLookupOrder, rememberGridDiskSrc } from './diskSrcLookup';

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
    const hit = rememberGridDiskSrc({ kind: 'active' }, 'al-1', 512, '/data/800.webp');
    expect(hit).toBe(true);
    expect(vi.mocked(rememberDiskSrc).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(vi.mocked(notifyCoverDiskReady)).toHaveBeenCalledTimes(1);
  });
});
