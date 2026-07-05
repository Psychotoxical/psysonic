/**
 * Index-first behaviour matrix for the Now Playing metadata resolvers (#1046).
 * Index hit → no Subsonic call; index miss → network fallback (when reachable);
 * index off → network fallback; unreachable → index still runs, no network call
 * (PR #1049 gate split). The byte-style guard inside `getSongForServer` is
 * exercised by useNowPlayingFetchers.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import type { LibraryAdvancedSearchResponse } from '@/lib/api/library';
import * as subsonicArtists from '@/lib/api/subsonicArtists';
import * as subsonicLibrary from '@/lib/api/subsonicLibrary';

// Network reachability is decided by the guard; mock it so we can test both arms.
vi.mock('@/lib/network/subsonicNetworkGuard', () => ({
  shouldAttemptSubsonicForServer: vi.fn(() => true),
}));
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';
import {
  resolveNpAlbum,
  resolveNpDiscography,
  resolveNpTopSongs,
  resolveNpSongMeta,
} from '@/features/nowPlaying/utils/nowPlayingMetadataResolve';

const guard = vi.mocked(shouldAttemptSubsonicForServer);

const ready = () =>
  onInvoke('library_get_status', () => ({
    serverId: 's1', libraryScope: '', syncPhase: 'ready',
    capabilityFlags: 0, libraryTier: 'unknown', syncedAt: 0,
  }));

const search = (over: Partial<LibraryAdvancedSearchResponse>): LibraryAdvancedSearchResponse => ({
  artists: [], albums: [], tracks: [],
  totals: { artists: 0, albums: 0, tracks: 0 },
  appliedFilters: [], source: 'local', ...over,
});

beforeEach(() => {
  useLibraryIndexStore.setState({ masterEnabled: true });
  vi.restoreAllMocks();
  guard.mockReturnValue(true);
});

describe('resolveNpAlbum', () => {
  it('index hit → no getAlbumForServer call', async () => {
    ready();
    onInvoke('library_get_tracks_by_album', () => [
      { serverId: 's1', id: 't1', title: 'Track', album: 'Alb', albumId: 'al1', artistId: 'ar1', durationSec: 100, syncedAt: 0, rawJson: {} },
    ]);
    onInvoke('library_advanced_search', () => search({ albums: [{ serverId: 's1', id: 'al1', name: 'Alb', artistId: 'ar1', syncedAt: 0, rawJson: {} }] }));
    const spy = vi.spyOn(subsonicLibrary, 'getAlbumForServer');
    const res = await resolveNpAlbum('s1', 'al1');
    expect(spy).not.toHaveBeenCalled();
    expect(res?.album.id).toBe('al1');
  });

  it('index miss + reachable → getAlbumForServer fallback', async () => {
    ready();
    onInvoke('library_get_tracks_by_album', () => []);
    const spy = vi.spyOn(subsonicLibrary, 'getAlbumForServer')
      .mockResolvedValue({ album: { id: 'al1', name: 'Net' } as never, songs: [] });
    const res = await resolveNpAlbum('s1', 'al1');
    expect(spy).toHaveBeenCalledWith('s1', 'al1');
    expect(res?.album.id).toBe('al1');
  });

  it('index off → getAlbumForServer fallback', async () => {
    useLibraryIndexStore.setState({ masterEnabled: false });
    const spy = vi.spyOn(subsonicLibrary, 'getAlbumForServer')
      .mockResolvedValue({ album: { id: 'al1', name: 'Net' } as never, songs: [] });
    await resolveNpAlbum('s1', 'al1');
    expect(spy).toHaveBeenCalledWith('s1', 'al1');
  });

  it('unreachable → index runs, no network fallback', async () => {
    guard.mockReturnValue(false);
    ready();
    onInvoke('library_get_tracks_by_album', () => []); // index miss
    const spy = vi.spyOn(subsonicLibrary, 'getAlbumForServer');
    const res = await resolveNpAlbum('s1', 'al1');
    expect(spy).not.toHaveBeenCalled();
    expect(res).toBeNull();
  });
});

describe('resolveNpDiscography', () => {
  it('index hit → no getArtistForServer call', async () => {
    ready();
    onInvoke('library_advanced_search', () => search({
      albums: [
        { serverId: 's1', id: 'al1', name: 'A1', artistId: 'ar1', syncedAt: 0, rawJson: {} },
        { serverId: 's1', id: 'al2', name: 'A2', artistId: 'other', syncedAt: 0, rawJson: {} },
      ],
    }));
    const spy = vi.spyOn(subsonicArtists, 'getArtistForServer');
    const albums = await resolveNpDiscography('s1', 'ar1');
    expect(spy).not.toHaveBeenCalled();
    expect(albums.map(a => a.id)).toEqual(['al1']);
  });

  it('index empty + reachable → getArtistForServer fallback', async () => {
    ready();
    onInvoke('library_advanced_search', () => search({ albums: [] }));
    const spy = vi.spyOn(subsonicArtists, 'getArtistForServer')
      .mockResolvedValue({ albums: [{ id: 'al9' }] } as never);
    const albums = await resolveNpDiscography('s1', 'ar1');
    expect(spy).toHaveBeenCalledWith('s1', 'ar1');
    expect(albums.map(a => a.id)).toEqual(['al9']);
  });

  it('unreachable + index empty → no network, empty list', async () => {
    guard.mockReturnValue(false);
    ready();
    onInvoke('library_advanced_search', () => search({ albums: [] }));
    const spy = vi.spyOn(subsonicArtists, 'getArtistForServer');
    const albums = await resolveNpDiscography('s1', 'ar1');
    expect(spy).not.toHaveBeenCalled();
    expect(albums).toEqual([]);
  });
});

describe('resolveNpTopSongs', () => {
  // Index path: artist's discography albums → their tracks → sort by play_count.
  it('index hit → top tracks from the artist albums, by play count', async () => {
    ready();
    onInvoke('library_advanced_search', () => search({
      albums: [{ serverId: 's1', id: 'al1', name: 'A1', artistId: 'ar1', syncedAt: 0, rawJson: {} }],
    }));
    onInvoke('library_get_tracks_by_album', () => [
      { serverId: 's1', id: 't-lo', title: 'Low', album: 'A1', artistId: 'ar1', durationSec: 1, playCount: 2, syncedAt: 0, rawJson: {} },
      { serverId: 's1', id: 't-hi', title: 'High', album: 'A1', artistId: 'ar1', durationSec: 1, playCount: 9, syncedAt: 0, rawJson: {} },
    ]);
    const spy = vi.spyOn(subsonicArtists, 'getTopSongsForServer');
    const songs = await resolveNpTopSongs('s1', 'ar1', 'Artist One');
    expect(spy).not.toHaveBeenCalled();
    expect(songs.map(s => s.id)).toEqual(['t-hi', 't-lo']); // play_count desc
  });

  it('index has no albums + reachable → getTopSongsForServer fallback', async () => {
    ready();
    onInvoke('library_advanced_search', () => search({ albums: [] }));
    const spy = vi.spyOn(subsonicArtists, 'getTopSongsForServer')
      .mockResolvedValue([{ id: 'net1' } as never]);
    const songs = await resolveNpTopSongs('s1', 'ar1', 'Artist One');
    expect(spy).toHaveBeenCalledWith('s1', 'Artist One');
    expect(songs.map(s => s.id)).toEqual(['net1']);
  });

  it('unreachable + no index albums → no network, empty', async () => {
    guard.mockReturnValue(false);
    ready();
    onInvoke('library_advanced_search', () => search({ albums: [] }));
    const spy = vi.spyOn(subsonicArtists, 'getTopSongsForServer');
    const songs = await resolveNpTopSongs('s1', 'ar1', 'Artist One');
    expect(spy).not.toHaveBeenCalled();
    expect(songs).toEqual([]);
  });
});

describe('resolveNpSongMeta', () => {
  it('index hit → no getSongForServer call', async () => {
    ready();
    onInvoke('library_get_track', () => ({
      serverId: 's1', id: 't1', title: 'Local', album: 'Alb', artistId: 'ar1', durationSec: 100,
      genre: 'Doom', playCount: 5, syncedAt: 0, rawJson: {},
    }));
    const spy = vi.spyOn(subsonicLibrary, 'getSongForServer');
    const song = await resolveNpSongMeta('s1', 't1');
    expect(spy).not.toHaveBeenCalled();
    expect(song?.genre).toBe('Doom');
  });

  it('index miss → getSongForServer fallback', async () => {
    ready();
    onInvoke('library_get_track', () => null);
    const spy = vi.spyOn(subsonicLibrary, 'getSongForServer')
      .mockResolvedValue({ id: 't1', title: 'Net' } as never);
    const song = await resolveNpSongMeta('s1', 't1');
    expect(spy).toHaveBeenCalledWith('s1', 't1');
    expect(song?.title).toBe('Net');
  });

  it('index off → getSongForServer fallback', async () => {
    useLibraryIndexStore.setState({ masterEnabled: false });
    const spy = vi.spyOn(subsonicLibrary, 'getSongForServer').mockResolvedValue(null);
    await resolveNpSongMeta('s1', 't1');
    expect(spy).toHaveBeenCalledWith('s1', 't1');
  });
});
