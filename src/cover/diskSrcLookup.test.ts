import { describe, expect, it, vi, beforeEach } from 'vitest';
import { albumCoverRef } from './ref';

vi.mock('./diskSrcCache', () => ({
  rememberDiskSrc: vi.fn(() => 'asset://cover.webp'),
  getDiskSrc: vi.fn(() => ''),
  splitPathVersion: (fsPath: string) => {
    const sep = fsPath.lastIndexOf('|');
    if (sep < 0 || !/^\d+$/.test(fsPath.slice(sep + 1))) {
      return { path: fsPath, version: '' };
    }
    return { path: fsPath.slice(0, sep), version: fsPath.slice(sep + 1) };
  },
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

  it('seeds the versioned URL from the `path|version` wire format', () => {
    const hit = rememberDiskSrcLadder(
      'srv',
      { cacheKind: 'album', cacheEntityId: 'al-1' },
      128,
      '/data/800.webp|1787826019',
    );
    expect(hit).toBe(true);
    const calls = vi.mocked(rememberDiskSrc).mock.calls;
    expect(calls.some(([k, v]) => k === 'srv:cover:album:al-1:128' && v === '/data/800.webp|1787826019')).toBe(true);
  });

  it('applies full-res seed guards to versioned paths too', () => {
    const ref = albumCoverRef('al-1', 'al-1');
    rememberGridDiskSrc(ref, 2000, '/data/512.webp|1787826019');
    const keys = vi.mocked(rememberDiskSrc).mock.calls.map(c => c[0]);
    expect(keys.some(k => k.endsWith(':2000'))).toBe(false);
    expect(keys.some(k => k.endsWith(':512'))).toBe(true);
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

  it('never seeds display keys from a full-res (2000) file', () => {
    const ref = albumCoverRef('al-1', 'al-1');
    rememberGridDiskSrc(ref, 2000, '/data/2000.webp');
    const keys = vi.mocked(rememberDiskSrc).mock.calls.map(c => c[0]);
    // Only the 2000 key may be seeded from a 2000.webp file. A tier-2000 file
    // can be the Navidrome vinyl placeholder written by the lightbox's full-res
    // path for a coverless album; seeding :800 with it is exactly the
    // single-frame hero flash (vinyl shows for one frame, then the re-ensure
    // peek reseeds :800 with real art).
    expect(keys).toEqual(['_:cover:album:al-1:2000']);
  });

  it('seeds display keys from an 800 file as before', () => {
    const ref = albumCoverRef('al-1', 'al-1');
    rememberGridDiskSrc(ref, 800, '/data/800.webp');
    const keys = vi.mocked(rememberDiskSrc).mock.calls.map(c => c[0]);
    expect(keys.some(k => k.endsWith(':800'))).toBe(true);
    expect(keys.some(k => k.endsWith(':512'))).toBe(true);
    expect(keys.some(k => k.endsWith(':256'))).toBe(true);
    expect(keys.some(k => k.endsWith(':128'))).toBe(true);
  });
});
