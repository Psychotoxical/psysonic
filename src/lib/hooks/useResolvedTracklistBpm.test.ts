import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';

const mocks = vi.hoisted(() => ({
  libraryGetTracksBatchChunked: vi.fn(),
  libraryIsReady: vi.fn(),
}));

vi.mock('@/lib/api/library', () => ({
  libraryGetTracksBatchChunked: mocks.libraryGetTracksBatchChunked,
}));
vi.mock('@/lib/library/libraryReady', () => ({
  libraryIsReady: mocks.libraryIsReady,
}));
vi.mock('@/lib/server/serverIndexKey', () => ({
  resolveIndexKey: (serverId: string) => serverId === 'profile-1' ? 'index-1' : serverId,
}));

import { useResolvedTracklistBpm } from './useResolvedTracklistBpm';

const songs: SubsonicSong[] = [{
  id: 'track-1',
  serverId: 'server-1',
  title: 'Track',
  artist: 'Artist',
  album: 'Album',
  albumId: 'album-1',
  duration: 120,
  bpm: 90,
}];

describe('useResolvedTracklistBpm', () => {
  beforeEach(() => {
    mocks.libraryIsReady.mockReset().mockResolvedValue(true);
    mocks.libraryGetTracksBatchChunked.mockReset().mockResolvedValue([{
      serverId: 'server-1',
      id: 'track-1',
      bpm: 128,
    }]);
  });

  it('overlays analysis-resolved bpm over the song tag', async () => {
    const { result } = renderHook(() => useResolvedTracklistBpm(songs, true));

    await waitFor(() => expect(result.current[0].bpm).toBe(128));
    expect(mocks.libraryGetTracksBatchChunked).toHaveBeenCalledWith([
      { serverId: 'server-1', trackId: 'track-1' },
    ]);
  });

  it('does not read the index while the bpm column is disabled', () => {
    const { result } = renderHook(() => useResolvedTracklistBpm(songs, false));

    expect(result.current).toBe(songs);
    expect(mocks.libraryIsReady).not.toHaveBeenCalled();
    expect(mocks.libraryGetTracksBatchChunked).not.toHaveBeenCalled();
  });

  it('uses the page owner when a network song has no server id', async () => {
    const unowned = [{ ...songs[0], serverId: undefined }];
    const { result } = renderHook(() => useResolvedTracklistBpm(unowned, true, 'server-1'));

    await waitFor(() => expect(result.current[0].bpm).toBe(128));
    expect(mocks.libraryGetTracksBatchChunked).toHaveBeenCalledWith([
      { serverId: 'server-1', trackId: 'track-1' },
    ]);
  });

  it('matches profile ids with canonical library keys', async () => {
    mocks.libraryGetTracksBatchChunked.mockResolvedValueOnce([{
      serverId: 'index-1',
      id: 'track-1',
      bpm: 128,
    }]);
    const profiled = [{ ...songs[0], serverId: 'profile-1' }];
    const { result } = renderHook(() => useResolvedTracklistBpm(profiled, true));

    await waitFor(() => expect(result.current[0].bpm).toBe(128));
  });
});
