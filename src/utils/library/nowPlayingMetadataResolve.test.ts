/**
 * Index-first behaviour matrix for the Now Playing metadata resolvers (#1046).
 * Each resolver: index hit → no Subsonic call; index miss → network fallback;
 * index disabled → network fallback. The byte-style guard inside
 * `getSongForServer` is exercised by useNowPlayingFetchers.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import type { LibraryAdvancedSearchResponse } from '@/api/library';
import * as subsonicArtists from '@/api/subsonicArtists';
import * as subsonicLibrary from '@/api/subsonicLibrary';
import {
  resolveNpAlbum,
  resolveNpDiscography,
  resolveNpTopSongs,
  resolveNpSongMeta,
} from './nowPlayingMetadataResolve';

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
    expect(res?.songs.map(s => s.id)).toEqual(['t1']);
  });

  it('index miss → getAlbumForServer fallback', async () => {
    ready();
    onInvoke('library_get_tracks_by_album', () => []); // no rows → null → fallback
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
    expect(albums.map(a => a.id)).toEqual(['al1']); // 'other' filtered out
  });

  it('index empty → getArtistForServer fallback', async () => {
    ready();
    onInvoke('library_advanced_search', () => search({ albums: [] }));
    const spy = vi.spyOn(subsonicArtists, 'getArtistForServer')
      .mockResolvedValue({ albums: [{ id: 'al9' }] } as never);
    const albums = await resolveNpDiscography('s1', 'ar1');
    expect(spy).toHaveBeenCalledWith('s1', 'ar1');
    expect(albums.map(a => a.id)).toEqual(['al9']);
  });

  it('index off → getArtistForServer fallback', async () => {
    useLibraryIndexStore.setState({ masterEnabled: false });
    const spy = vi.spyOn(subsonicArtists, 'getArtistForServer')
      .mockResolvedValue({ albums: [] } as never);
    await resolveNpDiscography('s1', 'ar1');
    expect(spy).toHaveBeenCalledWith('s1', 'ar1');
  });
});

describe('resolveNpTopSongs', () => {
  it('index hit → no getTopSongsForServer call, filtered + capped', async () => {
    ready();
    onInvoke('library_advanced_search', () => search({
      source: 'local',
      tracks: [
        { serverId: 's1', id: 't1', title: 'T1', album: 'Alb', artistId: 'ar1', durationSec: 1, playCount: 9, syncedAt: 0, rawJson: {} },
        { serverId: 's1', id: 'tx', title: 'TX', album: 'Alb', artistId: 'other', durationSec: 1, playCount: 99, syncedAt: 0, rawJson: {} },
      ],
    }));
    const spy = vi.spyOn(subsonicArtists, 'getTopSongsForServer');
    const songs = await resolveNpTopSongs('s1', 'ar1', 'Artist One');
    expect(spy).not.toHaveBeenCalled();
    expect(songs.map(s => s.id)).toEqual(['t1']); // 'other' artist filtered out
  });

  it('index returns no matching tracks → getTopSongsForServer fallback', async () => {
    ready();
    onInvoke('library_advanced_search', () => search({ source: 'local', tracks: [] }));
    const spy = vi.spyOn(subsonicArtists, 'getTopSongsForServer')
      .mockResolvedValue([{ id: 'net1' } as never]);
    const songs = await resolveNpTopSongs('s1', 'ar1', 'Artist One');
    expect(spy).toHaveBeenCalledWith('s1', 'Artist One');
    expect(songs.map(s => s.id)).toEqual(['net1']);
  });

  it('index off → getTopSongsForServer fallback', async () => {
    useLibraryIndexStore.setState({ masterEnabled: false });
    const spy = vi.spyOn(subsonicArtists, 'getTopSongsForServer').mockResolvedValue([]);
    await resolveNpTopSongs('s1', 'ar1', 'Artist One');
    expect(spy).toHaveBeenCalledWith('s1', 'Artist One');
  });
});

describe('resolveNpSongMeta', () => {
  it('index hit → no getSongForServer call', async () => {
    ready();
    onInvoke('library_get_track', () => ({
      serverId: 's1', id: 't1', title: 'Local', artistId: 'ar1', durationSec: 100,
      genre: 'Doom', playCount: 5, syncedAt: 0, rawJson: {},
    }));
    const spy = vi.spyOn(subsonicLibrary, 'getSongForServer');
    const song = await resolveNpSongMeta('s1', 't1');
    expect(spy).not.toHaveBeenCalled();
    expect(song?.id).toBe('t1');
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
