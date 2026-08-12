import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { useOfflineJobStore } from '@/features/offline';
import { useArtistOfflineState } from '@/features/artist/hooks/useArtistOfflineState';
import {
  activateCanonicalNavidromeOwners,
  canonicalizeNavidromeId,
  deactivateCanonicalNavidromeOwners,
} from '@/lib/server/navidromeCanonicalIds';

describe('useArtistOfflineState', () => {
  beforeEach(() => {
    deactivateCanonicalNavidromeOwners(['srv']);
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

  it('keeps legacy bulk progress and jobs visible after canonical activation', () => {
    const legacyArtistId = '00112233-4455-6677-8899-aabbccddeeff';
    const canonicalArtistId = canonicalizeNavidromeId(legacyArtistId);
    const legacyAlbumId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const canonicalAlbumId = canonicalizeNavidromeId(legacyAlbumId);
    useOfflineJobStore.setState({
      bulkProgress: { [`srv:${legacyArtistId}`]: { done: 0, total: 1 } },
      pinQueue: [{
        albumId: legacyAlbumId, albumName: 'One', pinKind: 'artist',
        status: 'downloading', queuedAt: 1, serverId: 'srv',
      }],
      jobs: [],
    });
    activateCanonicalNavidromeOwners(['srv']);

    const { result } = renderHook(() =>
      useArtistOfflineState(canonicalArtistId, 'srv', [canonicalAlbumId]),
    );

    expect(result.current.status).toBe('downloading');
    expect(result.current.progress).toEqual({ done: 0, total: 1 });
  });
});
