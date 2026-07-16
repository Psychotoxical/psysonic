import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOfflineJobStore } from '@/features/offline';
import { useAlbumOfflineState } from '@/features/album/hooks/useAlbumOfflineState';

describe('useAlbumOfflineState', () => {
  beforeEach(() => {
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
      }],
    });

    const { result } = renderHook(() => useAlbumOfflineState('alb-1', 'srv', ['t1']));
    expect(result.current.resolvedOfflineStatus).toBe('downloading');
    expect(result.current.offlineProgress).toEqual({ done: 0, total: 1 });
  });
});
