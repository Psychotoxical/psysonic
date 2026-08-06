import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '@/lib/media/trackTypes';
import { useAuthStore } from '@/store/authStore';
import { lyricsCache, useLyrics } from '@/features/lyrics/hooks/useLyrics';
import { lyricsCacheKey } from '@/features/lyrics/utils/lyricsPersistentCache';

const mocks = vi.hoisted(() => ({
  getLyricsBySongId: vi.fn(),
  getCachedLyrics: vi.fn(),
  putCachedLyrics: vi.fn(),
}));

vi.mock('@/lib/api/subsonicLyrics', () => ({ getLyricsBySongId: mocks.getLyricsBySongId }));
vi.mock('@/features/lyrics/utils/lyricsPersistentCache', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/lyrics/utils/lyricsPersistentCache')>();
  return {
    ...actual,
    getCachedLyrics: mocks.getCachedLyrics,
    putCachedLyrics: mocks.putCachedLyrics,
  };
});

const track: Track = {
  id: 'shared-song-id',
  title: 'Owned song',
  artist: 'Artist',
  album: 'Album',
  albumId: 'album-1',
  duration: 180,
  serverId: 'srv-owner',
};

beforeEach(() => {
  lyricsCache.clear();
  mocks.getLyricsBySongId.mockReset();
  mocks.getCachedLyrics.mockReset().mockResolvedValue(null);
  mocks.putCachedLyrics.mockReset().mockResolvedValue(undefined);
  useAuthStore.setState({
    activeServerId: 'srv-active',
    servers: [],
    lyricsSources: [
      { id: 'server', enabled: true },
      { id: 'lrclib', enabled: false },
      { id: 'netease', enabled: false },
    ],
  });
});

describe('useLyrics owner scope', () => {
  it('keeps identical raw song ids in separate RAM buckets', async () => {
    lyricsCache.set(lyricsCacheKey('srv-owner', 'shared-song-id'), {
      syncedLines: null,
      wordLines: null,
      plainLyrics: 'Owner lyrics',
      source: 'server',
      notFound: false,
    });
    lyricsCache.set(lyricsCacheKey('srv-other', 'shared-song-id'), {
      syncedLines: null,
      wordLines: null,
      plainLyrics: 'Other lyrics',
      source: 'lrclib',
      notFound: false,
    });

    const { result, rerender } = renderHook(
      ({ current }) => useLyrics(current),
      { initialProps: { current: track } },
    );
    await waitFor(() => expect(result.current.plainLyrics).toBe('Owner lyrics'));

    rerender({ current: { ...track, serverId: 'srv-other' } });
    await waitFor(() => expect(result.current.plainLyrics).toBe('Other lyrics'));
    expect(mocks.getLyricsBySongId).not.toHaveBeenCalled();
  });

  it('keeps an in-flight server fetch and cache write pinned to the track owner', async () => {
    let resolveLyrics!: (value: unknown) => void;
    mocks.getLyricsBySongId.mockReturnValue(new Promise(resolve => { resolveLyrics = resolve; }));

    const { result } = renderHook(() => useLyrics(track));
    await waitFor(() => expect(mocks.getLyricsBySongId).toHaveBeenCalledWith(
      'shared-song-id',
      { enhanced: false, serverId: 'srv-owner' },
    ));

    act(() => useAuthStore.setState({ activeServerId: 'srv-other' }));
    resolveLyrics({ line: [{ start: 0, value: 'Owner lyrics' }], synced: true });

    await waitFor(() => expect(result.current.source).toBe('server'));
    expect(mocks.putCachedLyrics).toHaveBeenCalledWith(
      lyricsCacheKey('srv-owner', 'shared-song-id'),
      expect.objectContaining({ source: 'server', notFound: false }),
    );
    expect(lyricsCache.has(lyricsCacheKey('srv-owner', 'shared-song-id'))).toBe(true);
    expect(lyricsCache.has(lyricsCacheKey('srv-other', 'shared-song-id'))).toBe(false);
  });
});
