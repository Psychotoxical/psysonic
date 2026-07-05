import { describe, it, expect, beforeEach, vi } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import {
  resolveTrackCoverArtId,
  runLocalAdvancedSearch,
  runLocalSongBrowse,
  runNetworkAdvancedYearAlbums,
  trackToSong,
  tryRunLocalAdvancedSearch,
} from './advancedSearchLocal';
import * as albumBrowseNetwork from './albumBrowseNetwork';

const opts = (over: Partial<Parameters<typeof runLocalAdvancedSearch>[1]> = {}) => ({
  query: '',
  genre: '',
  yearFrom: '',
  yearTo: '',
  bpmFrom: '',
  bpmTo: '',
  moodGroup: '',
  losslessOnly: false,
  resultType: 'all' as const,
  ...over,
});

const ready = () =>
  onInvoke('library_get_status', () => ({
    serverId: 's1',
    libraryScope: '',
    syncPhase: 'ready',
    capabilityFlags: 0,
    libraryTier: 'unknown',
    syncedAt: 0,
  }));

describe('runLocalAdvancedSearch', () => {
  beforeEach(() => {
    useLibraryIndexStore.setState({ masterEnabled: true });
  });

  it('returns null (→ network fallback) when the index is not ready', async () => {
    onInvoke('library_get_status', () => ({ serverId: 's1', libraryScope: '', syncPhase: 'initial_sync' }));
    const res = await runLocalAdvancedSearch('s1', opts({ query: 'x' }), 100);
    expect(res).toBeNull();
  });

  it('returns null when the index is disabled for the server', async () => {
    useLibraryIndexStore.setState({ masterEnabled: false });
    const res = await runLocalAdvancedSearch('s1', opts({ query: 'x' }), 100);
    expect(res).toBeNull();
  });

  it('passes libraryScope from the sidebar music library filter', async () => {
    useAuthStore.setState({ musicLibraryFilterByServer: { s1: 'lib7' } });
    ready();
    let captured: unknown;
    onInvoke('library_advanced_search', (args) => {
      captured = args;
      return {
        artists: [],
        albums: [],
        tracks: [],
        totals: { artists: 0, albums: 0, tracks: 0 },
        source: 'local',
      };
    });
    await runLocalAdvancedSearch('s1', opts({ query: 'x' }), 100);
    expect(captured).toMatchObject({ request: { libraryScope: 'lib7' } });
  });

  it('passes lossless is_true filter to library_advanced_search', async () => {
    ready();
    let captured: unknown;
    onInvoke('library_advanced_search', (args) => {
      captured = args;
      return {
        artists: [],
        albums: [],
        tracks: [],
        totals: { artists: 0, albums: 0, tracks: 0 },
        source: 'local',
      };
    });
    await runLocalAdvancedSearch('s1', opts({ losslessOnly: true }), 100);
    expect(captured).toMatchObject({
      request: { filters: [{ field: 'lossless', op: 'is_true' }] },
    });
  });

  it('passes bpm between filter to library_advanced_search', async () => {
    ready();
    let captured: unknown;
    onInvoke('library_advanced_search', (args) => {
      captured = args;
      return {
        artists: [],
        albums: [],
        tracks: [],
        totals: { artists: 0, albums: 0, tracks: 0 },
        source: 'local',
      };
    });
    await runLocalAdvancedSearch('s1', opts({ bpmFrom: '120', bpmTo: '130' }), 100);
    expect(captured).toMatchObject({
      request: { filters: [{ field: 'bpm', op: 'between', value: 120, valueTo: 130 }] },
    });
  });

  it('resolveTrackCoverArtId falls back to albumId when coverArtId is empty', () => {
    expect(
      resolveTrackCoverArtId(
        { coverArtId: undefined, albumId: 'al-42' },
        { coverArt: '', albumId: 'al-42' },
      ),
    ).toBe('al-42');
    expect(resolveTrackCoverArtId({ coverArtId: 'cv1', albumId: 'al-42' })).toBe('cv1');
  });

  it('resolveTrackCoverArtId prefers raw_json mf art over stale index column', () => {
    expect(
      resolveTrackCoverArtId(
        { coverArtId: 'mf-disc1', albumId: 'al-box' },
        { coverArt: 'mf-disc2', albumId: 'al-box', discNumber: 2 },
      ),
    ).toBe('mf-disc2');
  });

  it('trackToSong sets coverArt from albumId when the index row has no cover_art_id', () => {
    const song = trackToSong({
      serverId: 's1',
      id: 't1',
      title: 'T',
      album: 'Alb',
      albumId: 'al-42',
      durationSec: 100,
      syncedAt: 0,
      rawJson: { id: 't1', title: 'T', artist: 'A', album: 'Alb', albumId: 'al-42', duration: 100 },
    });
    expect(song.coverArt).toBe('al-42');
  });

  it('trackToSong keeps resolved bpm and source over rawJson tag', () => {
    const song = trackToSong({
      serverId: 's1',
      id: 't1',
      title: 'T',
      album: 'Alb',
      durationSec: 100,
      syncedAt: 0,
      bpm: 128,
      bpmSource: 'analysis',
      rawJson: { id: 't1', title: 'T', artist: 'A', album: 'Alb', albumId: 'al1', duration: 100, bpm: 90 },
    });
    expect(song.bpm).toBe(128);
    expect(song.localBpmSource).toBe('analysis');
  });

  it('prefers rawJson, falls back to hot columns, and reports the full total', async () => {
    ready();
    onInvoke('library_advanced_search', () => ({
      artists: [],
      albums: [],
      tracks: [
        {
          serverId: 's1', id: 't1', title: 'Hot Title', album: 'Alb', albumId: 'al1',
          durationSec: 100, syncedAt: 0,
          // rawJson is the authoritative original song — must win.
          rawJson: {
            id: 't1', title: 'Raw Title', artist: 'Raw Artist', album: 'Alb', albumId: 'al1',
            duration: 100, contributors: [{ role: 'composer', artist: { name: 'C' } }],
          },
        },
        {
          serverId: 's1', id: 't2', title: 'Only Hot', album: 'Alb2', albumId: 'al2',
          artist: 'Hot Artist', durationSec: 200, year: 1999, genre: 'Rock',
          starredAt: 1_700_000_000_000, syncedAt: 0,
          rawJson: {}, // sparse → hot-column fallback
        },
      ],
      totals: { artists: 0, albums: 0, tracks: 42 },
      appliedFilters: [],
      source: 'local',
    }));

    const res = await runLocalAdvancedSearch('s1', opts({ resultType: 'songs' }), 100);
    expect(res).not.toBeNull();
    expect(res!.songs).toHaveLength(2);

    // rawJson wins where present + carries OpenSubsonic extras.
    expect(res!.songs[0].title).toBe('Raw Title');
    expect(res!.songs[0].artist).toBe('Raw Artist');
    expect(res!.songs[0].contributors).toBeDefined();

    // hot-column fallback when rawJson is sparse.
    expect(res!.songs[1].title).toBe('Only Hot');
    expect(res!.songs[1].artist).toBe('Hot Artist');
    expect(res!.songs[1].year).toBe(1999);
    expect(res!.songs[1].genre).toBe('Rock');
    expect(res!.songs[1].starred).toBeTruthy();

    // Total is the full match count, not the page size.
    expect(res!.songsTotal).toBe(42);
  });

  it('returns null without throwing when the local query errors', async () => {
    ready();
    onInvoke('library_advanced_search', () => {
      throw new Error('boom');
    });
    const res = await runLocalAdvancedSearch('s1', opts({ query: 'x' }), 100);
    expect(res).toBeNull();
  });
});

describe('runLocalSongBrowse', () => {
  beforeEach(() => {
    useLibraryIndexStore.setState({ masterEnabled: true });
  });

  it('returns null for a missing server id (→ network browse)', async () => {
    expect(await runLocalSongBrowse(null, 0, 50)).toBeNull();
  });

  it('returns null (→ network browse) when the index is not ready', async () => {
    onInvoke('library_get_status', () => ({ serverId: 's1', libraryScope: '', syncPhase: 'initial_sync' }));
    expect(await runLocalSongBrowse('s1', 0, 50)).toBeNull();
  });

  it('returns null when the response is not local', async () => {
    ready();
    onInvoke('library_advanced_search', () => ({
      artists: [], albums: [], tracks: [],
      totals: { artists: 0, albums: 0, tracks: 0 }, appliedFilters: [], source: 'network',
    }));
    expect(await runLocalSongBrowse('s1', 0, 50)).toBeNull();
  });

  it('maps the local browse page to Subsonic songs (rawJson wins)', async () => {
    ready();
    onInvoke('library_advanced_search', () => ({
      artists: [],
      albums: [],
      tracks: [
        {
          serverId: 's1', id: 't1', title: 'Hot', album: 'Alb', albumId: 'al1',
          durationSec: 100, syncedAt: 0,
          rawJson: { id: 't1', title: 'Raw', artist: 'Raw Artist', album: 'Alb', albumId: 'al1', duration: 100 },
        },
      ],
      totals: { artists: 0, albums: 0, tracks: 1 }, appliedFilters: [], source: 'local',
    }));
    const songs = await runLocalSongBrowse('s1', 0, 50);
    expect(songs).not.toBeNull();
    expect(songs!).toHaveLength(1);
    expect(songs![0].title).toBe('Raw');
    expect(songs![0].artist).toBe('Raw Artist');
  });

  it('returns null without throwing on error', async () => {
    ready();
    onInvoke('library_advanced_search', () => {
      throw new Error('boom');
    });
    expect(await runLocalSongBrowse('s1', 0, 50)).toBeNull();
  });
});

describe('tryRunLocalAdvancedSearch', () => {
  beforeEach(() => {
    useLibraryIndexStore.setState({ masterEnabled: true });
  });

  it('retries without the ready gate when sync is still in progress', async () => {
    onInvoke('library_get_status', () => ({
      serverId: 's1',
      libraryScope: '',
      syncPhase: 'initial_sync',
      localTrackCount: 100,
      serverTrackCount: 1000,
      capabilityFlags: 0,
      libraryTier: 'unknown',
      syncedAt: 0,
    }));
    let searchCalls = 0;
    onInvoke('library_advanced_search', () => {
      searchCalls += 1;
      return {
        source: 'local',
        artists: [],
        albums: [],
        tracks: [],
        totals: { artists: 0, albums: 0, tracks: 0 },
        appliedFilters: ['year'],
      };
    });
    const res = await tryRunLocalAdvancedSearch('s1', opts({ yearFrom: '2020' }), 100);
    expect(res).not.toBeNull();
    expect(searchCalls).toBe(1);
  });
});

describe('runNetworkAdvancedYearAlbums', () => {
  it('passes open-ended year bounds to album browse (not 1900…now defaults)', async () => {
    const spy = vi.spyOn(albumBrowseNetwork, 'fetchAlbumBrowseNetwork').mockResolvedValue({
      albums: [{
        id: 'a1',
        name: 'Al',
        artist: 'Ar',
        artistId: 'ar1',
        songCount: 1,
        duration: 100,
      }],
      hasMore: false,
    });
    await runNetworkAdvancedYearAlbums(opts({ yearTo: '1990' }), 100);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ year: { to: 1990 } }),
      0,
      100,
    );
    spy.mockRestore();
  });
});
