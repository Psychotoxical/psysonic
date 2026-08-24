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

  it('does not count failed tracks as completed downloads', () => {
    useOfflineJobStore.setState({
      pinQueue: [{
        albumId: 'alb-1',
        albumName: 'One',
        pinKind: 'album',
        status: 'downloading',
        queuedAt: Date.now(),
        serverId: 'srv',
      }],
      jobs: [
        {
          trackId: 't1', albumId: 'alb-1', albumName: 'One', trackTitle: 'One',
          trackIndex: 0, totalTracks: 3, status: 'done', downloadId: 'dl-1', serverId: 'srv',
        },
        {
          trackId: 't2', albumId: 'alb-1', albumName: 'One', trackTitle: 'Two',
          trackIndex: 1, totalTracks: 3, status: 'error', downloadId: 'dl-1', serverId: 'srv',
        },
        {
          trackId: 't3', albumId: 'alb-1', albumName: 'One', trackTitle: 'Three',
          trackIndex: 2, totalTracks: 3, status: 'downloading', downloadId: 'dl-1', serverId: 'srv',
        },
      ],
    });

    const { result } = renderHook(() => useAlbumOfflineState('alb-1', 'srv', ['t1', 't2', 't3']));
    expect(result.current.offlineProgress).toEqual({ done: 1, total: 3 });
  });
});
