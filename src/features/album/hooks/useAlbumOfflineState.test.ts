import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOfflineJobStore } from '@/features/offline';
import { useAlbumOfflineState } from '@/features/album/hooks/useAlbumOfflineState';
import {
  activateCanonicalNavidromeOwners,
  canonicalizeNavidromeId,
  deactivateCanonicalNavidromeOwners,
} from '@/lib/server/navidromeCanonicalIds';

describe('useAlbumOfflineState', () => {
  beforeEach(() => {
    deactivateCanonicalNavidromeOwners(['srv']);
    useOfflineJobStore.setState({ jobs: [], pinQueue: [], bulkProgress: {} });
  });

  it('reports queued when the album waits in the pin queue', () => {
    useOfflineJobStore.setState({
      pinQueue: [{
        albumId: 'alb-1',
        albumName: 'One',
        pinKind: 'album',
        status: 'queued',
        queuedAt: Date.now(),
        serverId: 'srv',
      }],
    });

    const { result } = renderHook(() => useAlbumOfflineState('alb-1', 'srv', ['t1']));
    expect(result.current.resolvedOfflineStatus).toBe('queued');
    expect(result.current.offlineProgress).toBeNull();
  });

  it('prefers downloading over queued when jobs are active', () => {
    useOfflineJobStore.setState({
      pinQueue: [{
        albumId: 'alb-1',
        albumName: 'One',
        pinKind: 'album',
        status: 'downloading',
        queuedAt: Date.now(),
        serverId: 'srv',
      }],
      jobs: [{
        trackId: 't1',
        albumId: 'alb-1',
        albumName: 'One',
        trackTitle: 'Track',
        trackIndex: 0,
        totalTracks: 1,
        status: 'downloading',
        downloadId: 'dl-1',
        serverId: 'srv',
      }],
    });

    const { result } = renderHook(() => useAlbumOfflineState('alb-1', 'srv', ['t1']));
    expect(result.current.resolvedOfflineStatus).toBe('downloading');
    expect(result.current.offlineProgress).toEqual({ done: 0, total: 1 });
  });

  it('ignores a duplicate album id downloading on another server', () => {
    useOfflineJobStore.setState({
      pinQueue: [{
        albumId: 'alb-1',
        albumName: 'Other',
        pinKind: 'album',
        status: 'downloading',
        queuedAt: Date.now(),
        serverId: 'other',
      }],
      jobs: [],
    });

    const { result } = renderHook(() => useAlbumOfflineState('alb-1', 'srv', ['t1']));
    expect(result.current.resolvedOfflineStatus).toBe('none');
  });

  it('keeps a legacy active job visible after canonical owner activation', () => {
    const legacyAlbumId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const canonicalAlbumId = canonicalizeNavidromeId(legacyAlbumId);
    useOfflineJobStore.setState({
      jobs: [{
        trackId: 't1', albumId: legacyAlbumId, albumName: 'One', trackTitle: 'Track',
        trackIndex: 0, totalTracks: 1, status: 'downloading', downloadId: 'dl-1', serverId: 'srv',
      }],
      pinQueue: [],
      bulkProgress: {},
    });
    activateCanonicalNavidromeOwners(['srv']);

    const { result } = renderHook(() => useAlbumOfflineState(canonicalAlbumId, 'srv', ['missing']));

    expect(result.current.resolvedOfflineStatus).toBe('downloading');
    expect(result.current.offlineProgress).toEqual({ done: 0, total: 1 });
  });
});
