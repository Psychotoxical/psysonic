/**
 * Regression tests for the id-gating tuple pattern in `useArtistDetailData`.
 *
 * `info` (the SubsonicArtistInfo returned by getArtistInfo) is held as a
 * `{ id, value }` tuple internally and gated on id-match at the return
 * statement. Without this gate, navigating between /artist/A → /artist/B
 * would render one frame with A's `largeImageUrl` paired with B's id —
 * exactly the cache-mismatch shape that PR #732 fixed for the queue info
 * panel and that the shared ArtistCard (now used on this page) would
 * otherwise persist into IndexedDB.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicArtistInfo } from '@/lib/api/subsonicTypes';

vi.mock('@/lib/api/subsonicArtists');
vi.mock('@/lib/api/subsonicSearch');
vi.mock('@/lib/hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => ({ status: 'connected' }),
}));
vi.mock('@/lib/network/subsonicNetworkGuard', () => ({
  shouldAttemptSubsonicForServer: () => true,
}));
vi.mock('@/features/offline/utils/offlineBrowseMode', () => ({
  isOfflineBrowseActive: () => false,
  useOfflineBrowseActive: () => false,
}));

import {
  getArtist,
  getArtistForServer,
  getArtistInfo,
  getArtistInfoForServer,
  getTopSongs,
  getTopSongsForServer,
} from '@/lib/api/subsonicArtists';
import { search, searchForServer } from '@/lib/api/subsonicSearch';
import { useArtistDetailData } from '@/features/artist/hooks/useArtistDetailData';
import { useAuthStore } from '@/store/authStore';

const mockArtistInfo = vi.mocked(getArtistInfo) as unknown as {
  mockImplementation: (impl: (id: string) => Promise<SubsonicArtistInfo | null>) => void;
};

beforeEach(() => {
  useAuthStore.setState({
    activeServerId: null,
    servers: [],
    libraryBrowseServerIds: [],
    musicFoldersByServer: {},
    libraryBrowseSelectionByServer: {},
  });
  vi.mocked(getTopSongs).mockResolvedValue([]);
  vi.mocked(getTopSongsForServer).mockResolvedValue([]);
  vi.mocked(search).mockResolvedValue({ songs: [], albums: [], artists: [] });
  vi.mocked(searchForServer).mockResolvedValue({ songs: [], albums: [], artists: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

function routerWrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(MemoryRouter, null, children);
}

function secondaryServerWrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(
    MemoryRouter,
    { initialEntries: ['/artist/A?server=srv-b'] },
    children,
  );
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('useArtistDetailData — id-gated info', () => {
  it('loads artist detail, info, and featured search from the explicit secondary server', async () => {
    useAuthStore.setState({
      activeServerId: 'srv-a',
      servers: [
        { id: 'srv-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
        { id: 'srv-b', name: 'B', url: 'https://b.test', username: 'u', password: 'p' },
      ],
    });
    vi.mocked(getArtistForServer).mockResolvedValue({
      artist: { id: 'A', name: 'Secondary Artist', serverId: 'srv-b' },
      albums: [],
    });
    vi.mocked(getArtistInfoForServer).mockResolvedValue({ biography: 'Secondary bio' });

    const { result } = renderHook(() => useArtistDetailData('A'), {
      wrapper: secondaryServerWrapper,
    });

    await waitFor(() => expect(result.current.artist?.name).toBe('Secondary Artist'));
    await waitFor(() => expect(result.current.info?.biography).toBe('Secondary bio'));
    await waitFor(() => expect(searchForServer).toHaveBeenCalledWith(
      'srv-b',
      'Secondary Artist',
      { songCount: 500, artistCount: 0, albumCount: 0 },
    ));
    expect(getArtistForServer).toHaveBeenCalledWith('srv-b', 'A');
    expect(getArtistInfoForServer).toHaveBeenCalledWith('srv-b', 'A', {
      similarArtistCount: undefined,
    });
    expect(getArtist).not.toHaveBeenCalled();
    expect(getArtistInfo).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('returns null info when id changes before the new fetch resolves', async () => {
    vi.mocked(getArtist).mockImplementation(async (id) => (
      { artist: { id, name: id }, albums: [] }
    ));
    const a = deferred<SubsonicArtistInfo | null>();
    const b = deferred<SubsonicArtistInfo | null>();
    mockArtistInfo.mockImplementation(async (id) => {
      if (id === 'A') return a.promise;
      if (id === 'B') return b.promise;
      return null;
    });

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useArtistDetailData(id),
      { initialProps: { id: 'A' }, wrapper: routerWrapper },
    );

    await act(async () => { a.resolve({ largeImageUrl: 'A.jpg' } as SubsonicArtistInfo); });
    await waitFor(() => expect(result.current.info).toEqual({ largeImageUrl: 'A.jpg' }));

    // Switch to artist B. info must flip to null until B's fetch resolves —
    // it must never carry A's largeImageUrl paired with B's id, since the
    // shared ArtistCard would build a `coverArtCacheKey(B, 80)` from `id`
    // and pair it with A's URL inside CachedImage.
    rerender({ id: 'B' });
    expect(result.current.info).toBeNull();

    await act(async () => { b.resolve({ largeImageUrl: 'B.jpg' } as SubsonicArtistInfo); });
    await waitFor(() => expect(result.current.info).toEqual({ largeImageUrl: 'B.jpg' }));
  });

  it('keeps the album-artist credit on featured compilation albums', async () => {
    // "Also featured on" synthesises albums from search3 child songs. A
    // compilation has no flat `albumArtist` on the child — the credit lives in
    // OpenSubsonic's structured `albumArtists` (and/or `displayAlbumArtist`).
    // Dropping it made the card render "—" instead of "Various Artists".
    vi.mocked(getArtist).mockResolvedValue({ artist: { id: 'A', name: 'A' }, albums: [] });
    vi.mocked(search).mockResolvedValue({
      artists: [],
      albums: [],
      songs: [
        {
          id: 's1', title: 'Track', artistId: 'A', artist: 'A',
          album: 'A Compilation', albumId: 'comp1', coverArt: 'c1', duration: 100,
          albumArtists: [{ id: 'va', name: 'Various Artists' }],
        },
        {
          id: 's2', title: 'Other', artistId: 'A', artist: 'A',
          album: 'Display Only', albumId: 'comp2', coverArt: 'c2', duration: 90,
          displayAlbumArtist: 'Various Artists',
        },
      ],
    });

    const { result } = renderHook(() => useArtistDetailData('A'), { wrapper: routerWrapper });

    await waitFor(() => expect(result.current.featuredAlbums).toHaveLength(2));
    const structured = result.current.featuredAlbums.find(a => a.id === 'comp1');
    const displayOnly = result.current.featuredAlbums.find(a => a.id === 'comp2');
    expect(structured?.artists).toEqual([{ id: 'va', name: 'Various Artists' }]);
    expect(displayOnly?.artist).toBe('Various Artists');
  });

  it('ignores a late-arriving resolve for a stale id', async () => {
    vi.mocked(getArtist).mockImplementation(async (id) => (
      { artist: { id, name: id }, albums: [] }
    ));
    const a = deferred<SubsonicArtistInfo | null>();
    mockArtistInfo.mockImplementation(async (id) => {
      if (id === 'A') return a.promise;
      if (id === 'B') return { largeImageUrl: 'B.jpg' } as SubsonicArtistInfo;
      return null;
    });

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useArtistDetailData(id),
      { initialProps: { id: 'A' }, wrapper: routerWrapper },
    );

    rerender({ id: 'B' });
    await waitFor(() => expect(result.current.info).toEqual({ largeImageUrl: 'B.jpg' }));

    // A's late resolve must not overwrite B's info.
    await act(async () => { a.resolve({ largeImageUrl: 'A.jpg' } as SubsonicArtistInfo); });
    expect(result.current.info).toEqual({ largeImageUrl: 'B.jpg' });
  });
});
