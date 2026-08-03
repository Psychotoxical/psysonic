import { describe, it, expect, beforeEach, vi } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import {
  albumToAlbum,
  resolveTrackCoverArtId,
  runLocalAdvancedSearch,
  runLocalSongBrowse,
  runLocalSongScopeBrowse,
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

function seedSingleServerScope() {
  useAuthStore.setState({
    activeServerId: 's1',
    servers: [{ id: 's1', name: 'S1', url: 'https://s1', username: 'u', password: 'p' }],
    libraryBrowseServerIds: [],
  });
}

describe('runLocalAdvancedSearch', () => {
  beforeEach(() => {
    resetAuthStore();
    seedSingleServerScope();
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
    expect(captured).toMatchObject({
      request: {
        libraryScope: 'lib7',
        libraryScopes: [{ serverId: 's1', libraryId: 'lib7' }],
      },
    });
  });

  it('passes ordered libraryScopes for multi-library selection', async () => {
    useAuthStore.setState({
      musicLibrarySelectionByServer: { s1: ['lib-b', 'lib-a'] },
      musicLibraryFilterByServer: { s1: 'lib-b' },
    });
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
    expect(captured).toMatchObject({
      request: {
        libraryScopes: [
          { serverId: 's1', libraryId: 'lib-b' },
          { serverId: 's1', libraryId: 'lib-a' },
        ],
      },
    });
  });

  it('declines multi-server local search when any selected index is not ready', async () => {
    useAuthStore.setState({
      servers: [
        { id: 'a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
        { id: 'b', name: 'B', url: 'https://b.test', username: 'u', password: 'p' },
      ],
      activeServerId: 'a',
      libraryBrowseServerIds: ['a', 'b'],
      musicFoldersByServer: {
        a: [{ id: 'lib-a', name: 'A' }],
        b: [{ id: 'lib-b', name: 'B' }],
      },
      libraryBrowseSelectionByServer: {},
    });
    onInvoke('library_get_status', args => {
      const serverId = (args as { serverId: string }).serverId;
      return {
        serverId,
        libraryScope: '',
        syncPhase: serverId === 'b.test' ? 'initial_sync' : 'ready',
      };
    });
    let searchCalls = 0;
    onInvoke('library_advanced_search', () => {
      searchCalls += 1;
      return { artists: [], albums: [], tracks: [], totals: { artists: 0, albums: 0, tracks: 0 }, source: 'local' };
    });

    await expect(runLocalAdvancedSearch('a', opts({ query: 'x' }), 100)).resolves.toBeNull();
    expect(searchCalls).toBe(0);
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

  it('trackToSong keeps hot albumId when rawJson omits or nulls albumId', () => {
    const fromNull = trackToSong({
      serverId: 's1',
      id: 't1',
      title: 'T',
      album: 'Diorama',
      albumId: 'al-diorama',
      durationSec: 100,
      syncedAt: 0,
      rawJson: { id: 't1', title: 'T', artist: 'Mol', album: 'Diorama', albumId: null, duration: 100 },
    });
    expect(fromNull.albumId).toBe('al-diorama');

    const fromMissing = trackToSong({
      serverId: 's1',
      id: 't2',
      title: 'T2',
      album: 'Diorama',
      albumId: 'al-diorama',
      durationSec: 100,
      syncedAt: 0,
      rawJson: { id: 't2', title: 'T2', artist: 'Mol', album: 'Diorama', duration: 100 },
    });
    expect(fromMissing.albumId).toBe('al-diorama');
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
    resetAuthStore();
    seedSingleServerScope();
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

  it('uses the scoped cursor reader for an ordinary selected-library browse', async () => {
    useAuthStore.setState({
      servers: [{ id: 's1', name: 'Server', url: '', username: '', password: '' }],
      libraryBrowseServerIds: ['s1'],
      musicFoldersByServer: { s1: [{ id: 'lib1', name: 'Library' }] },
      libraryBrowseSelectionByServer: {},
    });
    ready();
    let captured: unknown;
    onInvoke('library_scope_browse', args => {
      captured = args;
      return {
        albums: [], artists: [],
        tracks: [{ serverId: 's1', id: 't1', title: 'Song', album: 'Album', durationSec: 100, syncedAt: 1, rawJson: {} }],
        hasMore: true, nextCursor: 'next', source: 'local',
      };
    });
    const page = await runLocalSongScopeBrowse('s1', 50);
    expect(page?.songs).toHaveLength(1);
    expect(page?.nextCursor).toBe('next');
    expect(captured).toEqual(expect.objectContaining({
      request: expect.objectContaining({ entity: 'track', limit: 50 }),
    }));
  });
});

describe('tryRunLocalAdvancedSearch', () => {
  beforeEach(() => {
    resetAuthStore();
    seedSingleServerScope();
    useLibraryIndexStore.setState({ masterEnabled: true });
  });

  it('does not bypass readiness while sync is still in progress', async () => {
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
    expect(res).toBeNull();
    expect(searchCalls).toBe(0);
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
      undefined,
    );
    spy.mockRestore();
  });
});

describe('albumToAlbum', () => {
  it('prefers cleared starred_at over stale raw_json starred', () => {
    const album = albumToAlbum({
      serverId: 's1',
      id: 'al1',
      name: 'Album',
      artist: 'Artist',
      artistId: 'ar1',
      songCount: 1,
      durationSec: 100,
      year: null,
      genre: null,
      coverArtId: null,
      starredAt: null,
      syncedAt: 0,
      rawJson: { id: 'al1', starred: '2024-01-01T00:00:00Z' },
    });
    expect(album.starred).toBeUndefined();
  });

  it('keeps year from raw_json when the indexed column is empty', () => {
    const album = albumToAlbum({
      serverId: 's1',
      id: 'al1',
      name: 'Album',
      artist: 'Artist',
      artistId: 'ar1',
      songCount: 1,
      durationSec: 100,
      year: null,
      genre: null,
      coverArtId: null,
      starredAt: null,
      syncedAt: 0,
      rawJson: { id: 'al1', year: 1999, genre: 'Rock' },
    });
    expect(album.year).toBe(1999);
    expect(album.genre).toBe('Rock');
  });

  it('maps a local catalog creation timestamp to the album created date', () => {
    const album = albumToAlbum({
      serverId: 's1', id: 'al1', name: 'Album', artist: 'Artist', artistId: 'ar1',
      songCount: 1, durationSec: 100, year: null, genre: null, coverArtId: null,
      starredAt: null, syncedAt: 0, rawJson: { createdMs: 1_700_000_000_000 },
    });
    expect(album.created).toBe('2023-11-14T22:13:20.000Z');
  });

  it('keeps the resolved album artist when raw_json carries the legacy performer', () => {
    // The backend resolves a compilation's hot columns to the album-artist entity,
    // while raw_json still holds the server's legacy `artist` / `artistId` — a
    // representative performer. Letting those win would relink a Various Artists
    // album to a single guest.
    const album = albumToAlbum({
      serverId: 's1',
      id: 'comp1',
      name: 'Comp One',
      artist: 'Various Artists',
      artistId: 'va',
      songCount: 2,
      durationSec: 400,
      year: null,
      genre: null,
      coverArtId: null,
      starredAt: null,
      syncedAt: 0,
      rawJson: { id: 'comp1', artist: 'Perf One', artistId: 'p1' },
    });
    expect(album.artistId).toBe('va');
    expect(album.artist).toBe('Various Artists');
  });

  it('still fills an empty album artist from raw_json', () => {
    const album = albumToAlbum({
      serverId: 's1', id: 'al1', name: 'Album', artist: null, artistId: null,
      songCount: 1, durationSec: 100, year: null, genre: null, coverArtId: null,
      starredAt: null, syncedAt: 0, rawJson: { artist: 'Artist', artistId: 'ar1' },
    });
    expect(album.artistId).toBe('ar1');
    expect(album.artist).toBe('Artist');
  });

  it('fills an empty artistId from raw_json for a non-VA album with a set name', () => {
    // A resolved credit but an empty hot id, with the id living only in raw_json:
    // this must still link (distinct from the VA-unlink case below).
    const album = albumToAlbum({
      serverId: 's1', id: 'al1', name: 'Album', artist: 'Solo Artist', artistId: null,
      songCount: 1, durationSec: 100, year: null, genre: null, coverArtId: null,
      starredAt: null, syncedAt: 0, rawJson: { artistId: 'solo' },
    });
    expect(album.artistId).toBe('solo');
    expect(album.artist).toBe('Solo Artist');
  });

  it('does not relink a VA album whose credit lives only in raw_json', () => {
    // Empty hot artist columns, with the "Various Artists" credit and a legacy
    // performer id both in raw_json: fill the name from raw, but keep it unlinked.
    const album = albumToAlbum({
      serverId: 's1', id: 'comp1', name: 'Comp', artist: null, artistId: null,
      songCount: 2, durationSec: 400, year: null, genre: null, coverArtId: null,
      starredAt: null, syncedAt: 0, rawJson: { artist: 'Various Artists', artistId: 'p1' },
    });
    expect(album.artist).toBe('Various Artists');
    expect(album.artistId ?? '').toBe('');
  });

  it('keeps a Various Artists album unlinked even when raw_json carries an id', () => {
    // The backend intentionally left artistId blank for a VA compilation with no
    // album-artist id; raw_json's legacy performer id must not re-link it.
    const album = albumToAlbum({
      serverId: 's1', id: 'comp1', name: 'Comp', artist: 'Various Artists', artistId: null,
      songCount: 2, durationSec: 400, year: null, genre: null, coverArtId: null,
      starredAt: null, syncedAt: 0, rawJson: { artistId: 'p1' },
    });
    expect(album.artistId ?? '').toBe('');
    expect(album.artist).toBe('Various Artists');
  });
});
