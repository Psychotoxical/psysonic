import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import type { ResolvedAlbum } from '@/store/mediaResolver';

// Scenario: offline mode × media resolution (closes review residual #2). The real
// offlineMediaResolve is registered into the mediaResolver seam; its offline-vs-network
// routing is driven through the actual decision inputs (offline-browse active + local
// browse enabled → the local-bytes path; otherwise the network path). Asserts which
// data source the seam call actually reaches — not internals.

function resolvedAlbum(id: string): ResolvedAlbum {
  return {
    album: { id, name: id, artist: 'A', artistId: 'aid', songCount: 0, duration: 0 } satisfies SubsonicAlbum,
    songs: [],
  };
}

const isOfflineBrowseActive = vi.hoisted(() => vi.fn(() => false));
const offlineLocalBrowseEnabled = vi.hoisted(() => vi.fn(() => false));
const loadAlbumFromLocalPlayback = vi.hoisted(() => vi.fn());
const shouldAttemptSubsonicForServer = vi.hoisted(() => vi.fn(() => true));
const getAlbumForServer = vi.hoisted(() => vi.fn());

vi.mock('@/features/offline/utils/offlineBrowseMode', async (io) => ({
  ...(await io<typeof import('@/features/offline/utils/offlineBrowseMode')>()),
  isOfflineBrowseActive,
}));
vi.mock('@/features/offline/utils/offlineLocalBrowse', async (io) => ({
  ...(await io<typeof import('@/features/offline/utils/offlineLocalBrowse')>()),
  offlineLocalBrowseEnabled,
  loadAlbumFromLocalPlayback,
}));
vi.mock('@/lib/network/subsonicNetworkGuard', async (io) => ({
  ...(await io<typeof import('@/lib/network/subsonicNetworkGuard')>()),
  shouldAttemptSubsonicForServer,
}));
vi.mock('@/lib/api/subsonicLibrary', async (io) => ({
  ...(await io<typeof import('@/lib/api/subsonicLibrary')>()),
  getAlbumForServer,
}));
vi.mock('@/lib/library/libraryReady', async (io) => ({
  ...(await io<typeof import('@/lib/library/libraryReady')>()),
  libraryIsReady: vi.fn(async () => false),
}));

import '@/features/offline/utils/offlineMediaResolve'; // registers the real resolver into the seam
import { resolveAlbum } from '@/store/mediaResolver';

beforeEach(() => {
  vi.clearAllMocks();
  isOfflineBrowseActive.mockReturnValue(false);
  offlineLocalBrowseEnabled.mockReturnValue(false);
  shouldAttemptSubsonicForServer.mockReturnValue(true);
  getAlbumForServer.mockResolvedValue(resolvedAlbum('network'));
  loadAlbumFromLocalPlayback.mockResolvedValue(resolvedAlbum('local'));
});

describe('offline mode × media resolution', () => {
  it('offline-browse active + local browse enabled → local-bytes path', async () => {
    isOfflineBrowseActive.mockReturnValue(true);
    offlineLocalBrowseEnabled.mockReturnValue(true);
    const out = await resolveAlbum('srv-1', 'alb-1');
    expect(loadAlbumFromLocalPlayback).toHaveBeenCalledWith('srv-1', 'alb-1');
    expect(getAlbumForServer).not.toHaveBeenCalled();
    expect(out).toEqual(resolvedAlbum('local'));
  });

  it('offline-browse inactive → network path', async () => {
    const out = await resolveAlbum('srv-1', 'alb-1');
    expect(getAlbumForServer).toHaveBeenCalledWith('srv-1', 'alb-1');
    expect(loadAlbumFromLocalPlayback).not.toHaveBeenCalled();
    expect(out).toEqual(resolvedAlbum('network'));
  });
});
