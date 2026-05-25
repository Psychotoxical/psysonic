import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api/coverCache', () => ({
  coverCacheEnsure: vi.fn(async () => {
    await new Promise(r => setTimeout(r, 5));
    return { hit: true, path: '/tmp/x.webp', tier: 128 };
  }),
}));

import { coverCacheEnsure } from '../api/coverCache';
import { coverArtRef } from './ref';
import { coverEnsureQueued } from './ensureQueue';

describe('coverEnsureQueued', () => {
  beforeEach(() => {
    vi.mocked(coverCacheEnsure).mockClear();
  });

  it('dedupes concurrent ensures for the same storage key', async () => {
    const ref = coverArtRef('al-1');
    const [a, b] = await Promise.all([
      coverEnsureQueued('s:cover:al-1:128', ref, 128, 'high'),
      coverEnsureQueued('s:cover:al-1:128', ref, 128, 'low'),
    ]);
    expect(a.path).toBe('/tmp/x.webp');
    expect(b.path).toBe('/tmp/x.webp');
    expect(vi.mocked(coverCacheEnsure)).toHaveBeenCalledTimes(1);
  });
});
