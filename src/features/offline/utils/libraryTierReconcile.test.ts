import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import {
  activateCanonicalNavidromeOwners,
  canonicalizeNavidromeId,
  deactivateCanonicalNavidromeOwners,
} from '@/lib/server/navidromeCanonicalIds';

const mocks = vi.hoisted(() => ({
  discoverLibraryTierOnDisk: vi.fn(),
  pruneOrphanLibraryTierFiles: vi.fn(async () => [] as string[]),
}));

vi.mock('@/lib/api/syncfs', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api/syncfs')>()),
  discoverLibraryTierOnDisk: mocks.discoverLibraryTierOnDisk,
  pruneOrphanLibraryTierFiles: mocks.pruneOrphanLibraryTierFiles,
}));

import { reconcileLibraryTierForServer } from './libraryTierReconcile';

const LEGACY_TRACK = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const CANONICAL_TRACK = canonicalizeNavidromeId(LEGACY_TRACK);

describe('library tier identity transitions', () => {
  beforeEach(() => {
    deactivateCanonicalNavidromeOwners(['srv-a', 'a.test']);
    mocks.discoverLibraryTierOnDisk.mockReset();
    mocks.pruneOrphanLibraryTierFiles.mockClear();
    useAuthStore.setState({
      servers: [{ id: 'srv-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' }],
      activeServerId: 'srv-a',
    });
    useLocalPlaybackStore.setState({
      entries: {
        [`a.test:${LEGACY_TRACK}`]: {
          serverIndexKey: 'a.test',
          trackId: LEGACY_TRACK,
          localPath: `/media/${LEGACY_TRACK}.flac`,
          layoutFingerprint: 'legacy',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'flac',
        },
      },
    });
  });

  it('does not delete canonical entries or files from a stale discovery result', async () => {
    let resolveDiscovery!: (hits: []) => void;
    mocks.discoverLibraryTierOnDisk.mockImplementation(() => new Promise(resolve => {
      resolveDiscovery = resolve;
    }));

    const reconcile = reconcileLibraryTierForServer('srv-a');
    await vi.waitFor(() => expect(mocks.discoverLibraryTierOnDisk).toHaveBeenCalledOnce());

    activateCanonicalNavidromeOwners(['srv-a', 'a.test']);
    useLocalPlaybackStore.setState({
      entries: {
        [`a.test:${CANONICAL_TRACK}`]: {
          serverIndexKey: 'a.test',
          trackId: CANONICAL_TRACK,
          localPath: `/media/${CANONICAL_TRACK}.flac`,
          layoutFingerprint: 'canonical',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'flac',
        },
      },
    });
    resolveDiscovery([]);
    await reconcile;

    expect(useLocalPlaybackStore.getState().entries[`a.test:${CANONICAL_TRACK}`]).toBeDefined();
    expect(mocks.pruneOrphanLibraryTierFiles).not.toHaveBeenCalled();
  });

  it('preserves a download committed after the disk snapshot started', async () => {
    let resolveDiscovery!: (hits: []) => void;
    mocks.discoverLibraryTierOnDisk.mockImplementation(() => new Promise(resolve => {
      resolveDiscovery = resolve;
    }));
    useLocalPlaybackStore.setState({ entries: {} });

    const reconcile = reconcileLibraryTierForServer('srv-a');
    await vi.waitFor(() => expect(mocks.discoverLibraryTierOnDisk).toHaveBeenCalledOnce());

    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'a.test',
      trackId: 'new-track',
      localPath: '/media/new-track.flac',
      layoutFingerprint: 'new',
      sizeBytes: 2,
      tier: 'library',
      suffix: 'flac',
    });
    resolveDiscovery([]);
    await reconcile;

    expect(useLocalPlaybackStore.getState().entries['a.test:new-track']).toBeDefined();
    expect(mocks.pruneOrphanLibraryTierFiles).toHaveBeenCalledWith(expect.objectContaining({
      keepPaths: ['/media/new-track.flac'],
    }));
  });

  it('does not delete index rows or files when disk discovery fails', async () => {
    mocks.discoverLibraryTierOnDisk.mockRejectedValue(new Error('disk unavailable'));

    const result = await reconcileLibraryTierForServer('srv-a');

    expect(result).toEqual({ syncedFromDisk: 0, removedStaleIndex: 0, orphansRemoved: 0 });
    expect(useLocalPlaybackStore.getState().entries[`a.test:${LEGACY_TRACK}`]).toBeDefined();
    expect(mocks.pruneOrphanLibraryTierFiles).not.toHaveBeenCalled();
  });
});
