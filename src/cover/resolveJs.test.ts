import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureCoverTierJs } from './resolveJs';
import type { CoverArtRef } from './types';

vi.mock('./imageCache', () => ({
  getCachedBlob: vi.fn(async () => new Blob(['x'], { type: 'image/jpeg' })),
}));

vi.mock('./imageCache/coverSiblings', () => ({
  parseCoverCacheKey: (key: string) => {
    const m = key.match(/^(.+):cover:(.+):(.+):(\d+)$/);
    if (!m) return null;
    return { stem: `${m[1]}:cover:${m[2]}:${m[3]}`, size: Number(m[4]) };
  },
  probeSiblingCoverBlobInMemory: () => null,
  probeSiblingCoverBlobFromIDB: async () => null,
  scheduleSiblingVersusNetworkRace: vi.fn(),
}));

const { blobMap } = vi.hoisted(() => ({ blobMap: new Map<string, Blob>() }));
vi.mock('./imageCache/blobCache', () => ({
  blobCache: blobMap,
  rememberBlob: (key: string, blob: Blob) => {
    blobMap.set(key, blob);
  },
}));

vi.mock('./imageCache/idbStore', () => ({
  putBlob: vi.fn(),
}));

vi.mock('./reachability', () => ({
  coverServerReachable: () => true,
}));

vi.mock('./fetchUrl', () => ({
  buildCoverArtFetchUrl: () => 'https://example.test/cover',
}));

const ref: CoverArtRef = {
  cacheKind: 'album',
  cacheEntityId: 'al-1',
  fetchCoverArtId: 'al-1',
  serverScope: { kind: 'active' },
};

describe('ensureCoverTierJs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when cover id missing', async () => {
    expect(await ensureCoverTierJs({ ...ref, fetchCoverArtId: '' }, 128)).toBeNull();
  });

  it('fetches via getCachedBlob on cold path', async () => {
    const { getCachedBlob } = await import('./imageCache');
    vi.mocked(getCachedBlob).mockImplementation(async (_url, key) => {
      const b = new Blob(['x'], { type: 'image/jpeg' });
      blobMap.set(key, b);
      return b;
    });
    const blob = await ensureCoverTierJs(ref, 128);
    expect(blob).toBeTruthy();
    expect(getCachedBlob).toHaveBeenCalled();
  });
});
