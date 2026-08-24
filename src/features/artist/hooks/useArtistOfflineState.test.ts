import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { useOfflineJobStore } from '@/features/offline';
import { useArtistOfflineState } from '@/features/artist/hooks/useArtistOfflineState';

describe('useArtistOfflineState', () => {
  beforeEach(() => {
    useOfflineJobStore.setState({ jobs: [], pinQueue: [], bulkProgress: {} });
    useLocalPlaybackStore.setState({ entries: {} });
  });

  it('reports cached when every album is pinned', () => {
    useLocalPlaybackStore.setState({
      entries: {
        'srv:al-1': {
          serverIndexKey: 'srv',
          trackId: 't1',
          localPath: '/x',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
          pinSource: { kind: 'artist', sourceId: 'al-1' },
        },
        'srv:al-2': {
          serverIndexKey: 'srv',
          trackId: 't2',
          localPath: '/y',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
          pinSource: { kind: 'artist', sourceId: 'al-2' },
        },
      },
    });

    const { result } = renderHook(() =>
      useArtistOfflineState('artist-1', 'srv', ['al-1', 'al-2']),
    );
    expect(result.current.status).toBe('cached');
  });

  it('does not report album-owned bytes as an artist cache', () => {
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'srv',
      trackId: 't1',
      localPath: '/x',
      layoutFingerprint: 'fp',
      sizeBytes: 1,
      tier: 'library',
      pinSource: { kind: 'album', sourceId: 'al-1' },
      suffix: 'mp3',
    });

    const { result } = renderHook(() =>
      useArtistOfflineState('artist-1', 'srv', ['al-1']),
    );
    expect(result.current.status).toBe('none');
  });

  it('reports queued when bulk progress is active but albums only wait in pin queue', () => {
    useOfflineJobStore.setState({
      bulkProgress: { 'srv:artist-1': { done: 0, total: 2 } },
      pinQueue: [
        { albumId: 'al-1', albumName: 'One', pinKind: 'artist', status: 'queued', queuedAt: 1, serverId: 'srv' },
        { albumId: 'al-2', albumName: 'Two', pinKind: 'artist', status: 'queued', queuedAt: 2, serverId: 'srv' },
      ],
      jobs: [],
    });

    const { result } = renderHook(() =>
      useArtistOfflineState('artist-1', 'srv', ['al-1', 'al-2']),
    );
    expect(result.current.status).toBe('queued');
    expect(result.current.progress).toEqual({ done: 0, total: 2 });
  });

  it('ignores duplicate album ids queued on another server', () => {
    useOfflineJobStore.setState({
      bulkProgress: { 'srv:artist-1': { done: 0, total: 1 } },
      pinQueue: [{
        albumId: 'al-1', albumName: 'Other', pinKind: 'artist', status: 'queued', queuedAt: 1, serverId: 'other',
      }],
      jobs: [],
    });

    const { result } = renderHook(() => useArtistOfflineState('artist-1', 'srv', ['al-1']));
    expect(result.current.status).toBe('downloading');
  });
});
