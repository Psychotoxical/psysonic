import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/coverCache', () => ({
  coverCachePeekBatch: vi.fn(),
}));

import { coverCachePeekBatch } from '../api/coverCache';
import { coverStorageKey } from './storageKeys';
import { coverArtRef } from './ref';
import { peekCoverPathOnDisk } from './peekCoverOnDisk';

const ref = coverArtRef('mf-x_1', { kind: 'active' });
const tier = 128 as const;

describe('peekCoverPathOnDisk', () => {
  beforeEach(() => {
    vi.mocked(coverCachePeekBatch).mockReset();
  });

  it('promotes mf-* to al-* when only the album folder exists on disk', async () => {
    const alKey = coverStorageKey(ref.serverScope, 'al-octa_2', tier);
    vi.mocked(coverCachePeekBatch)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ [alKey]: '/cache/al-octa_2/128.webp' });

    const path = await peekCoverPathOnDisk(ref, tier, { albumId: 'al-octa_2' });

    expect(path).toBe('/cache/al-octa_2/128.webp');
    expect(vi.mocked(coverCachePeekBatch)).toHaveBeenCalledTimes(2);
  });

  it('returns mf path when the mf folder exists', async () => {
    const mfKey = coverStorageKey(ref.serverScope, 'mf-x_1', tier);
    vi.mocked(coverCachePeekBatch).mockResolvedValueOnce({
      [mfKey]: '/cache/mf-x_1/128.webp',
    });

    const path = await peekCoverPathOnDisk(ref, tier, { albumId: 'al-octa_2' });

    expect(path).toBe('/cache/mf-x_1/128.webp');
    expect(vi.mocked(coverCachePeekBatch)).toHaveBeenCalledTimes(1);
  });
});
