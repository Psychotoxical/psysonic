/**
 * Regression tests for the id-gating tuple pattern in `useNowPlayingFetchers`.
 *
 * Each id-keyed slot (`artistInfo`, `songMeta`, `albumData`, `discography`) is
 * held as a `{ id, value }` tuple internally and gated on id-match at the
 * return statement. This guarantees that consumers building a `cacheKey` from
 * the current id can never receive a value paired with a previously-current
 * id — the bug that PR #732 fixed inside `NowPlayingInfo.tsx` and that this
 * hook would otherwise leak into every other consumer (e.g. ArtistCard on the
 * NowPlaying page).
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicArtistInfo, SubsonicSong, SubsonicAlbum, SubsonicArtist } from '../api/subsonicTypes';

vi.mock('../api/subsonicArtists');
vi.mock('../api/subsonicLibrary');
vi.mock('../api/bandsintown');
vi.mock('../utils/network/subsonicNetworkGuard', () => ({
  shouldAttemptSubsonicForServer: vi.fn(() => true),
}));

import { shouldAttemptSubsonicForServer } from '../utils/network/subsonicNetworkGuard';
import { getArtistForServer, getArtistInfoForServer, getTopSongsForServer } from '../api/subsonicArtists';
import { getAlbumForServer, getSongForServer } from '../api/subsonicLibrary';
import { fetchBandsintownEvents } from '../api/bandsintown';
import { useNowPlayingFetchers, type NowPlayingFetchersDeps } from './useNowPlayingFetchers';

// Resolved return shapes of the mocked API calls — used to cast deliberately
// partial test fixtures without `any`.
type ArtistForServer = Awaited<ReturnType<typeof getArtistForServer>>;
type AlbumForServer = Awaited<ReturnType<typeof getAlbumForServer>>;

// The real getArtistInfo signature returns `Promise<SubsonicArtistInfo>`, but
// the hook treats `null` as the "no info available" case and stores it as
// such in its tuple. The tests mirror that — cast to a nullable-returning
// shape so we can mock the empty case without `as any` at every site.
const mockArtistInfo = vi.mocked(getArtistInfoForServer) as unknown as {
  mockImplementation: (impl: (serverId: string, id: string) => Promise<SubsonicArtistInfo | null>) => void;
  mockResolvedValue: (v: SubsonicArtistInfo | null) => void;
};

const baseDeps: NowPlayingFetchersDeps = {
  songId: undefined,
  artistId: undefined,
  albumId: undefined,
  artistName: '',
  enableBandsintown: false,
  audiomuseNavidromeEnabled: false,
  enrichmentKey: '',
  currentTrack: null,
  subsonicServerId: 'srv1',
  fetchEnabled: true,
};

beforeEach(() => {
  vi.mocked(getTopSongsForServer).mockResolvedValue([]);
  vi.mocked(getArtistForServer).mockResolvedValue({ albums: [] } as unknown as ArtistForServer);
  vi.mocked(fetchBandsintownEvents).mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Deferred promise helper — lets a test step the fetch resolution manually. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('useNowPlayingFetchers — id-gated artistInfo', () => {
  it('returns null artistInfo while the previously-resolved info belongs to a different artistId', async () => {
    const a = deferred<SubsonicArtistInfo | null>();
    const b = deferred<SubsonicArtistInfo | null>();
    mockArtistInfo.mockImplementation(async (_sid, id) => {
      if (id === 'art-A') return a.promise;
      if (id === 'art-B') return b.promise;
      return null;
    });

    const { result, rerender } = renderHook(
      ({ artistId }: { artistId: string }) =>
        useNowPlayingFetchers({ ...baseDeps, artistId, artistName: artistId }),
      { initialProps: { artistId: 'art-A' } },
    );

    // Before any resolve, no info yet.
    expect(result.current.artistInfo).toBeNull();

    // Resolve A — artistInfo becomes A's info.
    await act(async () => { a.resolve({ largeImageUrl: 'A.jpg' } as SubsonicArtistInfo); });
    await waitFor(() => {
      expect(result.current.artistInfo).toEqual({ largeImageUrl: 'A.jpg' });
    });

    // Switch to artistId B. Without id-gating, artistInfo would still be A's
    // info paired with the new B id — the bug that PR #732 fixed in the queue
    // info panel. With gating, artistInfo flips to null immediately.
    rerender({ artistId: 'art-B' });
    expect(result.current.artistInfo).toBeNull();

    // Resolve B — artistInfo now becomes B's info, never paired with A.
    await act(async () => { b.resolve({ largeImageUrl: 'B.jpg' } as SubsonicArtistInfo); });
    await waitFor(() => {
      expect(result.current.artistInfo).toEqual({ largeImageUrl: 'B.jpg' });
    });
  });

  it('does not leak a late-arriving resolve for a stale artistId', async () => {
    // Race: artist A's fetch resolves AFTER the consumer switched to B.
    const a = deferred<SubsonicArtistInfo | null>();
    mockArtistInfo.mockImplementation(async (_sid, id) => {
      if (id === 'art-A') return a.promise;
      if (id === 'art-B') return { largeImageUrl: 'B.jpg' } as SubsonicArtistInfo;
      return null;
    });

    const { result, rerender } = renderHook(
      ({ artistId }: { artistId: string }) =>
        useNowPlayingFetchers({ ...baseDeps, artistId, artistName: artistId }),
      { initialProps: { artistId: 'art-A' } },
    );

    // Switch to B before A resolves.
    rerender({ artistId: 'art-B' });
    await waitFor(() => {
      expect(result.current.artistInfo).toEqual({ largeImageUrl: 'B.jpg' });
    });

    // Late A resolve must not overwrite the displayed value for B.
    await act(async () => { a.resolve({ largeImageUrl: 'A.jpg' } as SubsonicArtistInfo); });
    expect(result.current.artistInfo).toEqual({ largeImageUrl: 'B.jpg' });
  });
});

describe('useNowPlayingFetchers — id-gated songMeta / albumData / discography', () => {
  it('gates songMeta on songId match', async () => {
    const s1 = deferred<SubsonicSong | null>();
    const s2 = deferred<SubsonicSong | null>();
    vi.mocked(getSongForServer).mockImplementation(async (_sid, id) => {
      if (id === 's1') return s1.promise;
      if (id === 's2') return s2.promise;
      return null;
    });

    const { result, rerender } = renderHook(
      ({ songId }: { songId: string }) =>
        useNowPlayingFetchers({ ...baseDeps, songId }),
      { initialProps: { songId: 's1' } },
    );

    await act(async () => { s1.resolve({ id: 's1', title: 'Track 1' } as SubsonicSong); });
    await waitFor(() => expect(result.current.songMeta?.title).toBe('Track 1'));

    rerender({ songId: 's2' });
    expect(result.current.songMeta).toBeNull();

    await act(async () => { s2.resolve({ id: 's2', title: 'Track 2' } as SubsonicSong); });
    await waitFor(() => expect(result.current.songMeta?.title).toBe('Track 2'));
  });

  it('gates albumData on albumId match', async () => {
    const al1 = deferred<{ album: SubsonicAlbum; songs: SubsonicSong[] } | null>();
    const al2 = deferred<{ album: SubsonicAlbum; songs: SubsonicSong[] } | null>();
    vi.mocked(getAlbumForServer).mockImplementation(async (_sid, id) => {
      if (id === 'alb1') return al1.promise as unknown as AlbumForServer;
      if (id === 'alb2') return al2.promise as unknown as AlbumForServer;
      return null as unknown as AlbumForServer;
    });

    const { result, rerender } = renderHook(
      ({ albumId }: { albumId: string }) =>
        useNowPlayingFetchers({ ...baseDeps, albumId }),
      { initialProps: { albumId: 'alb1' } },
    );

    await act(async () => { al1.resolve({ album: { id: 'alb1', name: 'A1' } as SubsonicAlbum, songs: [] }); });
    await waitFor(() => expect(result.current.albumData?.album.name).toBe('A1'));

    rerender({ albumId: 'alb2' });
    expect(result.current.albumData).toBeNull();

    await act(async () => { al2.resolve({ album: { id: 'alb2', name: 'A2' } as SubsonicAlbum, songs: [] }); });
    await waitFor(() => expect(result.current.albumData?.album.name).toBe('A2'));
  });

  it('gates discography on artistId match (empty fallback while gated)', async () => {
    const d1 = deferred<{ artist: Partial<SubsonicArtist>; albums: SubsonicAlbum[] }>();
    const d2 = deferred<{ artist: Partial<SubsonicArtist>; albums: SubsonicAlbum[] }>();
    vi.mocked(getArtistForServer).mockImplementation(async (_sid, id) => {
      if (id === 'art-D1') return d1.promise as unknown as ArtistForServer;
      if (id === 'art-D2') return d2.promise as unknown as ArtistForServer;
      return { albums: [] } as unknown as ArtistForServer;
    });
    mockArtistInfo.mockResolvedValue(null);

    const { result, rerender } = renderHook(
      ({ artistId }: { artistId: string }) =>
        useNowPlayingFetchers({ ...baseDeps, artistId, artistName: artistId }),
      { initialProps: { artistId: 'art-D1' } },
    );

    await act(async () => { d1.resolve({ artist: {}, albums: [{ id: 'al-D1' } as SubsonicAlbum] }); });
    await waitFor(() => expect(result.current.discography.map(a => a.id)).toEqual(['al-D1']));

    rerender({ artistId: 'art-D2' });
    expect(result.current.discography).toEqual([]);

    await act(async () => { d2.resolve({ artist: {}, albums: [{ id: 'al-D2' } as SubsonicAlbum] }); });
    await waitFor(() => expect(result.current.discography.map(a => a.id)).toEqual(['al-D2']));
  });
});

describe('useNowPlayingFetchers — local-playback metadata', () => {
  // Regression: the metadata gate must never pass the playing track id, or the
  // guard's `psysonic-local://` skip would blank every Subsonic card whenever
  // the track plays from hot-cache / offline bytes. Guard is called with the
  // server id only.
  // Keep the shared guard mock at its permissive default after the behaviour
  // case below swaps in a trackId-sensitive implementation.
  afterEach(() => {
    vi.mocked(shouldAttemptSubsonicForServer).mockImplementation(() => true);
  });

  it('queries the network guard without a trackId', async () => {
    const guard = vi.mocked(shouldAttemptSubsonicForServer);
    renderHook(() => useNowPlayingFetchers({ ...baseDeps, songId: 'song-1', albumId: 'al-1', artistId: 'art-1', artistName: 'Artist' }));
    await waitFor(() => expect(guard).toHaveBeenCalled());
    for (const call of guard.mock.calls) {
      expect(call).toHaveLength(1);
      expect(call[1]).toBeUndefined();
    }
  });

  it('still loads album / discography / top songs when the playback bytes are local', async () => {
    // Mirror the real guard: a byte-style call (with a trackId resolving to
    // psysonic-local://) is blocked, but the metadata gate (server id only) is
    // allowed. If the hook ever passed the trackId again, every fetch below
    // would be gated off and the cards would blank — exactly the #1042 bug.
    // Ids are unique to this test so the shared module caches don't short-circuit it.
    vi.mocked(shouldAttemptSubsonicForServer).mockImplementation(
      (_serverId, trackId) => trackId === undefined,
    );
    vi.mocked(getSongForServer).mockResolvedValue({ id: 'np-song', title: 'Local Track' } as SubsonicSong);
    vi.mocked(getAlbumForServer).mockResolvedValue(
      { album: { id: 'np-al', name: 'Album' } as SubsonicAlbum, songs: [] },
    );
    vi.mocked(getArtistForServer).mockResolvedValue({ albums: [{ id: 'np-al' } as SubsonicAlbum] } as unknown as ArtistForServer);
    vi.mocked(getTopSongsForServer).mockResolvedValue([{ id: 'np-top' } as unknown as SubsonicSong]);

    const { result } = renderHook(() =>
      useNowPlayingFetchers({ ...baseDeps, songId: 'np-song', albumId: 'np-al', artistId: 'np-art', artistName: 'NP Artist' }),
    );

    await waitFor(() => expect(getAlbumForServer).toHaveBeenCalledWith('srv1', 'np-al'));
    await waitFor(() => expect(getArtistForServer).toHaveBeenCalledWith('srv1', 'np-art'));
    await waitFor(() => expect(getTopSongsForServer).toHaveBeenCalledWith('srv1', 'NP Artist'));
    await waitFor(() => expect(result.current.albumData?.album.id).toBe('np-al'));
    await waitFor(() => expect(result.current.discography.map(a => a.id)).toEqual(['np-al']));
    await waitFor(() => expect(result.current.topSongs.map(s => s.id)).toEqual(['np-top']));
  });
});
