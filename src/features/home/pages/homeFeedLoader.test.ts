import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicAlbum, SubsonicSong } from '@/lib/api/subsonicTypes';
import type { LibraryAlbumDto } from '@/lib/api/library/dto';
import type { HomeFeedSnapshot } from '@/features/home/store/homeFeedCache';

vi.mock('@/lib/library/libraryReady', () => ({
  readyLibraryServerKeys: vi.fn(async (serverIds: readonly string[]) => [...serverIds]),
}));

import { resetLibraryLocalReadSingleFlightsForTests } from '@/lib/library/localReadSingleFlight';
import {
  HOME_CHRONOLOGICAL_TIMEOUT_MS,
  HOME_LOCAL_READ_TIMEOUT_MS,
  HOME_REQUEST_TIMEOUT_MS,
  advanceHomeOffsets,
  allocateHomeQuotas,
  deriveHomeFeedScope,
  loadHomeChronologicalFeed,
  loadHomeFeed,
  loadHomeFeedWithStatus,
  loadMoreHomeAlbums,
  patchHomeChronologicalFeed,
  preserveHomeChronologicalFeeds,
  stableRoundRobin,
  withinHomeDeadline,
} from '@/features/home/pages/homeFeedLoader';

const mixConfig = { enabled: false, minSong: 0, minAlbum: 0, minArtist: 0 };

beforeEach(resetLibraryLocalReadSingleFlightsForTests);

function album(serverId: string, id: string): SubsonicAlbum {
  return { id, name: id, artist: 'Artist', artistId: 'artist', songCount: 1, duration: 1, serverId };
}

function albumDto(serverId: string, id: string): LibraryAlbumDto {
  return { serverId, id, name: id, syncedAt: 1, rawJson: {} };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function snapshot(): HomeFeedSnapshot {
  const offsets = {
    starred: { a: 2, b: 3 },
    recent: { offset: 5, hasMore: true },
    random: { a: 2, b: 3 },
    mostPlayed: { a: 2, b: 3 },
    recentlyPlayed: { offset: 5, hasMore: true },
  };
  return {
    scopeKey: 'scope', scopeVersion: 1, savedAt: 1, offsets,
    starred: [album('a', 'existing')], recent: [], random: [], heroAlbums: [],
    mostPlayed: [], recentlyPlayed: [], randomArtists: [], discoverSongs: [],
  };
}

describe('homeFeedLoader pure helpers', () => {
  it('allocates floor and remainder quotas in server order', () => {
    expect(allocateHomeQuotas(5, 3)).toEqual([2, 2, 1]);
    expect(allocateHomeQuotas(2, 4)).toEqual([1, 1, 0, 0]);
  });

  it('round-robins groups without reordering within a server', () => {
    expect(stableRoundRobin([['a1', 'a2'], ['b1'], ['c1', 'c2']], 5))
      .toEqual(['a1', 'b1', 'c1', 'a2', 'c2']);
  });

  it('builds a stable complete scope key in auth server order', () => {
    const scope = deriveHomeFeedScope({
      servers: [{ id: 'b' }, { id: 'a' }, { id: 'c' }],
      activeServerId: 'c',
      libraryBrowseServerIds: ['a', 'b'],
      libraryBrowseSelectionByServer: { a: [], b: ['jazz', 'rock'] },
    });
    expect(scope.serverIds).toEqual(['b', 'a']);
    expect(scope.scopeKey).toBe(JSON.stringify([['b', ['jazz', 'rock']], ['a', []]]));
    expect(deriveHomeFeedScope({
      servers: [{ id: 'a' }, { id: 'c' }], activeServerId: 'c',
      libraryBrowseServerIds: [], libraryBrowseSelectionByServer: { c: [] },
    }).serverIds).toEqual(['c']);
    expect(deriveHomeFeedScope({
      servers: [{ id: 'b' }, { id: 'a' }], activeServerId: 'b',
      libraryBrowseServerIds: ['b', 'a'], libraryBrowseSelectionByServer: { a: [], b: [] },
    }, new Set(['b']))).toEqual({
      serverIds: ['a'],
      scopeKey: JSON.stringify([['a', []]]),
    });
  });

  it('advances only the requested cursor by raw row counts', () => {
    const before = snapshot().offsets;
    const after = advanceHomeOffsets(before, 'starred', { a: 4, b: 1 });
    expect(after.starred).toEqual({ a: 6, b: 4 });
    expect(after.recent).toBe(before.recent);
  });

  it('returns the fallback when work exceeds the Home deadline', async () => {
    vi.useFakeTimers();
    const pending = new Promise<string>(() => {});
    const result = withinHomeDeadline(pending, 'timed-out');
    await vi.advanceTimersByTimeAsync(HOME_REQUEST_TIMEOUT_MS);
    await expect(result).resolves.toBe('timed-out');
    vi.useRealTimers();
  });
});

describe('homeFeedLoader failure isolation', () => {
  it('distinguishes failed all-empty loads from successful empty libraries', async () => {
    const base = {
      serverIds: ['a'], scopeKey: 'scope', scopeVersion: 1, randomSize: 0,
      anchorServerId: 'a', scopes: [], showArtists: false, showSongs: false, mixConfig,
      enabledSections: {
        starred: true,
        mostPlayed: false,
        hero: false,
        discover: false,
        discoverArtists: false,
        discoverSongs: false,
      },
    };
    const failed = await loadHomeFeedWithStatus({
      ...base,
      deps: {
        getAlbumListForServer: vi.fn(async () => { throw new Error('offline'); }) as never,
        filterAlbumsByMixRatingsAcrossServers: vi.fn(async albums => albums),
      },
    });
    const successfulEmpty = await loadHomeFeedWithStatus({
      ...base,
      deps: {
        getAlbumListForServer: vi.fn(async () => []) as never,
        filterAlbumsByMixRatingsAcrossServers: vi.fn(async albums => albums),
      },
    });

    expect(failed.snapshot.starred).toEqual([]);
    expect(failed.emptySnapshotReliable).toBe(false);
    expect(successfulEmpty.snapshot.starred).toEqual([]);
    expect(successfulEmpty.emptySnapshotReliable).toBe(true);
  });

  it('marks an all-timeout empty load as unreliable', async () => {
    vi.useFakeTimers();
    const result = loadHomeFeedWithStatus({
      serverIds: ['a'], scopeKey: 'scope', scopeVersion: 1, randomSize: 0,
      anchorServerId: 'a', scopes: [], showArtists: false, showSongs: false, mixConfig,
      enabledSections: {
        starred: true,
        mostPlayed: false,
        hero: false,
        discover: false,
        discoverArtists: false,
        discoverSongs: false,
      },
      deps: {
        getAlbumListForServer: vi.fn(() => new Promise<never>(() => undefined)) as never,
        filterAlbumsByMixRatingsAcrossServers: vi.fn(async albums => albums),
      },
    });

    await vi.advanceTimersByTimeAsync(HOME_REQUEST_TIMEOUT_MS);
    await expect(result).resolves.toMatchObject({ emptySnapshotReliable: false });
    vi.useRealTimers();
  });

  it('does not trust an empty snapshot when only some requested servers respond', async () => {
    const result = await loadHomeFeedWithStatus({
      serverIds: ['a', 'b'], scopeKey: 'scope', scopeVersion: 1, randomSize: 0,
      anchorServerId: 'a', scopes: [], showArtists: false, showSongs: false, mixConfig,
      enabledSections: {
        starred: true,
        mostPlayed: false,
        hero: false,
        discover: false,
        discoverArtists: false,
        discoverSongs: false,
      },
      deps: {
        getAlbumListForServer: vi.fn(async serverId => {
          if (serverId === 'b') throw new Error('offline');
          return [];
        }) as never,
        filterAlbumsByMixRatingsAcrossServers: vi.fn(async albums => albums),
      },
    });

    expect(result.snapshot.starred).toEqual([]);
    expect(result.emptySnapshotReliable).toBe(false);
  });

  it('reuses a timed-out chronological invoke until the native read settles', async () => {
    vi.useFakeTimers();
    const libraryScopeListMainstageAlbums = vi.fn(() => new Promise<never>(() => {}));
    const options = {
      anchorServerId: 'a',
      serverIds: ['a', 'b'],
      scopes: [{ serverId: 'a', libraryId: 'lib-a' }, { serverId: 'b', libraryId: 'lib-b' }],
      feed: 'newReleases' as const,
      deps: { libraryScopeListMainstageAlbums },
    };

    const first = loadHomeChronologicalFeed(options);
    const second = loadHomeChronologicalFeed(options);
    await vi.waitFor(() => expect(libraryScopeListMainstageAlbums).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(HOME_CHRONOLOGICAL_TIMEOUT_MS);

    await expect(first).resolves.toMatchObject({ status: 'timeout' });
    await expect(second).resolves.toMatchObject({ status: 'timeout' });
    expect(libraryScopeListMainstageAlbums).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('starts a fresh chronological flight when the sync freshness changes', async () => {
    const first = deferred<{ albums: LibraryAlbumDto[]; hasMore: boolean; genreCounts: [] }>();
    const second = deferred<{ albums: LibraryAlbumDto[]; hasMore: boolean; genreCounts: [] }>();
    const libraryScopeListMainstageAlbums = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const base = {
      anchorServerId: 'a',
      serverIds: ['a'],
      scopes: [{ serverId: 'a', libraryId: 'lib-a' }],
      feed: 'newReleases' as const,
      deps: { libraryScopeListMainstageAlbums },
    };

    const staleLoad = loadHomeChronologicalFeed({ ...base, freshness: 1 });
    const freshLoad = loadHomeChronologicalFeed({ ...base, freshness: 2 });
    await vi.waitFor(() => expect(libraryScopeListMainstageAlbums).toHaveBeenCalledTimes(2));

    second.resolve({ albums: [albumDto('a', 'fresh')], hasMore: false, genreCounts: [] });
    await expect(freshLoad).resolves.toMatchObject({
      status: 'success',
      albums: [expect.objectContaining({ id: 'fresh' })],
    });
    first.resolve({ albums: [albumDto('a', 'stale')], hasMore: false, genreCounts: [] });
    await expect(staleLoad).resolves.toMatchObject({
      status: 'success',
      albums: [expect.objectContaining({ id: 'stale' })],
    });
  });

  it('resolves the network snapshot while local chronological work is pending', async () => {
    vi.useFakeTimers();
    const getAlbumListForServer = vi.fn(async (
      serverId: string,
      type: string,
      size: number,
      _offset: number,
      _extra: Record<string, unknown>,
      _timeout: number,
      _libraryIds?: readonly string[],
    ) => {
      return Array.from({ length: size }, (_, index) => album(serverId, `${type}-${index}`));
    });
    const localPending = new Promise<never>(() => {});
    const libraryScopeListMainstageAlbums = vi.fn(() => localPending);
    const chronological = loadHomeChronologicalFeed({
      anchorServerId: 'a',
      scopes: [{ serverId: 'a', libraryId: 'lib-a' }, { serverId: 'b', libraryId: 'lib-b' }],
      feed: 'newReleases',
      deps: { libraryScopeListMainstageAlbums },
    });
    const result = await loadHomeFeed({
      serverIds: ['a', 'b'], scopeKey: 'scope', scopeVersion: 7, randomSize: 20,
      anchorServerId: 'a',
      scopes: [{ serverId: 'a', libraryId: 'lib-a' }, { serverId: 'b', libraryId: 'lib-b' }],
      showArtists: false, showSongs: false, mixConfig,
      deps: {
        getAlbumListForServer: getAlbumListForServer as never,
        libraryScopeListMainstageAlbums,
        getArtistsForServer: vi.fn(async () => []),
        getRandomSongsForServer: vi.fn(async () => []),
        runLocalRandomSongs: vi.fn(async () => null),
        runLocalRandomArtists: vi.fn(async () => null),
        filterAlbumsByMixRatingsAcrossServers: vi.fn(async albums => albums),
        shuffle: items => items,
      },
    });
    expect(getAlbumListForServer.mock.calls.map(call => call[1])).not.toContain('newest');
    expect(getAlbumListForServer.mock.calls.map(call => call[1])).not.toContain('recent');
    expect(result.recent).toEqual([]);
    expect(result.recentlyPlayed).toEqual([]);
    expect(result.starred.some(item => item.serverId === 'a')).toBe(true);
    expect(getAlbumListForServer.mock.calls.every(call => call[5] === HOME_REQUEST_TIMEOUT_MS)).toBe(true);
    let chronologicalSettled = false;
    void chronological.then(() => { chronologicalSettled = true; });
    await Promise.resolve();
    expect(chronologicalSettled).toBe(false);
    vi.useRealTimers();
  });

  it('preserves an existing chronological rail and hasMore after a local timeout', async () => {
    vi.useFakeTimers();
    const current = snapshot();
    current.recent = [album('a', 'prior')];
    const resultPromise = loadHomeChronologicalFeed({
      anchorServerId: 'a', scopes: [{ serverId: 'a', libraryId: 'lib-a' }],
      feed: 'newReleases',
      deps: {
        libraryScopeListMainstageAlbums: vi.fn(() => new Promise<{
          albums: LibraryAlbumDto[];
          hasMore: boolean;
          genreCounts: [];
        }>(() => {})),
      },
    });
    await vi.advanceTimersByTimeAsync(HOME_CHRONOLOGICAL_TIMEOUT_MS);
    const result = await resultPromise;
    expect(result).toEqual({ status: 'timeout', durationMs: HOME_CHRONOLOGICAL_TIMEOUT_MS });
    const patched = patchHomeChronologicalFeed(current, 'recent', result);
    expect(patched).toBe(current);
    expect(patched.recent.map(item => item.id)).toEqual(['prior']);
    expect(patched.offsets.recent).toEqual({ offset: 5, hasMore: true });
    const networkSnapshot = { ...current, recent: [], offsets: {
      ...current.offsets,
      recent: { offset: 0, hasMore: false },
    } };
    const preserved = preserveHomeChronologicalFeeds(networkSnapshot, current);
    expect(preserved.recent.map(item => item.id)).toEqual(['prior']);
    expect(preserved.offsets.recent).toEqual({ offset: 5, hasMore: true });
    vi.useRealTimers();
  });

  it('distinguishes a successful empty chronological query from an error', async () => {
    const success = await loadHomeChronologicalFeed({
      anchorServerId: 'a', scopes: [], feed: 'recentlyPlayed',
      deps: { libraryScopeListMainstageAlbums: vi.fn(async () => ({ albums: [], hasMore: false, genreCounts: [] })) },
    });
    const error = await loadHomeChronologicalFeed({
      anchorServerId: 'a', scopes: [], feed: 'recentlyPlayed',
      deps: { libraryScopeListMainstageAlbums: vi.fn(async () => { throw new Error('failed'); }) },
    });
    expect(success).toMatchObject({ status: 'success', albums: [], hasMore: false });
    expect(error).toMatchObject({ status: 'error' });
    expect(success.durationMs).toBeGreaterThanOrEqual(0);
    expect(error.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not request or process disabled sections', async () => {
    const getAlbumListForServer = vi.fn(async () => []);
    const getArtistsForServer = vi.fn(async () => []);
    const getRandomSongsForServer = vi.fn(async () => []);
    const runLocalRandomSongs = vi.fn(async () => null);
    const runLocalRandomArtists = vi.fn(async () => null);
    const filterAlbumsByMixRatingsAcrossServers = vi.fn(async albums => albums);
    const onSectionResult = vi.fn();

    const result = await loadHomeFeed({
      serverIds: ['a', 'b'], scopeKey: 'scope', scopeVersion: 1, randomSize: 20,
      anchorServerId: 'a', scopes: [], showArtists: true, showSongs: true, mixConfig,
      enabledSections: {
        starred: false,
        mostPlayed: false,
        hero: false,
        discover: false,
        discoverArtists: false,
        discoverSongs: false,
      },
      onSectionResult,
      deps: {
        getAlbumListForServer: getAlbumListForServer as never,
        getArtistsForServer,
        getRandomSongsForServer,
        runLocalRandomSongs,
        runLocalRandomArtists,
        filterAlbumsByMixRatingsAcrossServers,
        shuffle: items => items,
      },
    });

    expect(getAlbumListForServer).not.toHaveBeenCalled();
    expect(getArtistsForServer).not.toHaveBeenCalled();
    expect(runLocalRandomSongs).not.toHaveBeenCalled();
    expect(runLocalRandomArtists).not.toHaveBeenCalled();
    expect(getRandomSongsForServer).not.toHaveBeenCalled();
    expect(filterAlbumsByMixRatingsAcrossServers).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      starred: [], heroAlbums: [], random: [], mostPlayed: [], randomArtists: [], discoverSongs: [],
    });
    expect(onSectionResult).toHaveBeenCalledTimes(6);
    expect(onSectionResult.mock.calls).toEqual(expect.arrayContaining([
      ['starred', { status: 'disabled', durationMs: 0, itemCount: 0 }],
      ['mostPlayed', { status: 'disabled', durationMs: 0, itemCount: 0 }],
      ['hero', { status: 'disabled', durationMs: 0, itemCount: 0 }],
      ['discover', { status: 'disabled', durationMs: 0, itemCount: 0 }],
      ['discoverArtists', { status: 'disabled', durationMs: 0, itemCount: 0 }],
      ['discoverSongs', { status: 'disabled', durationMs: 0, itemCount: 0 }],
    ]));
  });

  it('reports per-output timings while sharing one random fetch per server', async () => {
    let now = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 5;
      return now;
    });
    const getAlbumListForServer = vi.fn(async (
      serverId: string,
      type: string,
      size: number,
    ) => Array.from({ length: size }, (_, index) => album(serverId, `${type}-${index}`)));
    const onSectionResult = vi.fn();

    const result = await loadHomeFeed({
      serverIds: ['a', 'b'], scopeKey: 'scope', scopeVersion: 1, randomSize: 20,
      anchorServerId: 'a', scopes: [], showArtists: false, showSongs: false, mixConfig,
      onSectionResult,
      deps: {
        getAlbumListForServer: getAlbumListForServer as never,
        getArtistsForServer: vi.fn(async () => []),
        getRandomSongsForServer: vi.fn(async () => []),
        runLocalRandomSongs: vi.fn(async () => null),
        runLocalRandomArtists: vi.fn(async () => null),
        filterAlbumsByMixRatingsAcrossServers: vi.fn(async albums => albums),
        shuffle: items => items,
      },
    });
    nowSpy.mockRestore();

    expect(getAlbumListForServer.mock.calls.filter(call => call[1] === 'random')).toHaveLength(2);
    expect(result.heroAlbums).toHaveLength(8);
    expect(result.random).toHaveLength(12);
    const reports = Object.fromEntries(onSectionResult.mock.calls) as Record<string, {
      status: 'success' | 'disabled';
      durationMs: number;
      itemCount: number;
      detail?: string;
    }>;
    expect(reports.starred).toMatchObject({ status: 'success', itemCount: 12 });
    expect(reports.mostPlayed).toMatchObject({ status: 'success', itemCount: 12 });
    expect(reports.hero).toMatchObject({
      status: 'success', itemCount: 8,
    });
    expect(reports.discover).toMatchObject({
      status: 'success', itemCount: 12,
    });
    expect(reports.hero.detail).toContain('shared random album fetch=');
    expect(reports.discover.detail).toContain('shared random album fetch=');
    for (const report of Object.values(reports).filter(value => value.status === 'success')) {
      expect(report.durationMs).toBeGreaterThan(0);
    }
  });

  it('passes the explicit Home library scope to every album request', async () => {
    const getAlbumListForServer = vi.fn(async (
      _serverId: string,
      _type: string,
      _size: number,
      _offset: number,
      _extra: Record<string, unknown>,
      _timeout: number,
      _libraryIds?: readonly string[],
    ) => []);

    await loadHomeFeed({
      serverIds: ['a', 'b'], scopeKey: 'scope', scopeVersion: 1, randomSize: 20,
      anchorServerId: 'a',
      scopes: [{ serverId: 'a', libraryId: 'lib-a' }, { serverId: 'b', libraryId: null }],
      showArtists: false, showSongs: false, mixConfig,
      deps: {
        getAlbumListForServer: getAlbumListForServer as never,
        filterAlbumsByMixRatingsAcrossServers: vi.fn(async albums => albums),
        shuffle: items => items,
      },
    });

    const callsForA = getAlbumListForServer.mock.calls.filter(call => call[0] === 'a');
    const callsForB = getAlbumListForServer.mock.calls.filter(call => call[0] === 'b');
    expect(callsForA.length).toBeGreaterThan(0);
    expect(callsForB.length).toBeGreaterThan(0);
    expect(callsForA.every(call => JSON.stringify(call[6]) === JSON.stringify(['lib-a']))).toBe(true);
    expect(callsForB.every(call => JSON.stringify(call[6]) === JSON.stringify([]))).toBe(true);
  });

  it('uses local random artists before the network and records each server source', async () => {
    const getArtistsForServer = vi.fn(async (serverId: string, _timeout?: number) => [
      { id: `network-${serverId}`, name: `Network ${serverId}` },
    ]);
    const runLocalRandomArtists = vi.fn(async (serverId: string | null | undefined) => (
      serverId === 'a' ? [{ id: 'local-a', name: 'Local A', serverId }] : null
    ));
    const onSectionResult = vi.fn();

    const result = await loadHomeFeed({
      serverIds: ['a', 'b'], scopeKey: 'scope', scopeVersion: 1, randomSize: 0,
      anchorServerId: 'a', scopes: [], showArtists: true, showSongs: false, mixConfig,
      onSectionResult,
      deps: {
        getAlbumListForServer: vi.fn(async () => []) as never,
        getArtistsForServer,
        getRandomSongsForServer: vi.fn(async () => []),
        runLocalRandomSongs: vi.fn(async () => null),
        runLocalRandomArtists,
        filterAlbumsByMixRatingsAcrossServers: vi.fn(async albums => albums),
        shuffle: items => items,
      },
    });

    expect(runLocalRandomArtists).toHaveBeenCalledWith('a', 8, []);
    expect(runLocalRandomArtists).toHaveBeenCalledWith('b', 8, []);
    expect(getArtistsForServer).toHaveBeenCalledTimes(1);
    const networkTimeout = getArtistsForServer.mock.calls[0]?.[1] ?? 0;
    expect(networkTimeout).toBeGreaterThan(0);
    expect(networkTimeout).toBeLessThanOrEqual(HOME_REQUEST_TIMEOUT_MS);
    expect(result.randomArtists.map(artist => `${artist.serverId}:${artist.id}`))
      .toEqual(['a:local-a', 'b:network-b']);
    const report = onSectionResult.mock.calls.find(([section]) => section === 'discoverArtists')?.[1];
    expect(report.detail).toContain('a: ');
    expect(report.detail).toContain('/local/rows');
    expect(report.detail).toContain('b: ');
    expect(report.detail).toContain('/network/rows');
  });

  it('falls back to network random artists and songs when local reads never settle', async () => {
    vi.useFakeTimers();
    const getArtistsForServer = vi.fn(async () => [{ id: 'network-artist', name: 'Network Artist' }]);
    const getRandomSongsForServer = vi.fn(async (
      _serverId: string,
      _size?: number,
      _genre?: string,
      _timeout?: number,
    ) => [{
      id: 'network-song', title: 'Network Song', artist: 'Artist', album: 'Album',
      albumId: 'album', duration: 60,
    } as SubsonicSong]);
    const never = new Promise<never>(() => undefined);

    const request = loadHomeFeed({
      serverIds: ['a'], scopeKey: 'scope', scopeVersion: 1, syncRevision: 3, randomSize: 0,
      anchorServerId: 'a', scopes: [], showArtists: true, showSongs: true, mixConfig,
      enabledSections: {
        starred: false,
        mostPlayed: false,
        hero: false,
        discover: false,
        discoverArtists: true,
        discoverSongs: true,
      },
      deps: {
        getAlbumListForServer: vi.fn(async () => []) as never,
        getArtistsForServer,
        getRandomSongsForServer,
        runLocalRandomArtists: vi.fn(() => never),
        runLocalRandomSongs: vi.fn(() => never),
        filterAlbumsByMixRatingsAcrossServers: vi.fn(async albums => albums),
        shuffle: items => items,
      },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(HOME_LOCAL_READ_TIMEOUT_MS - 1);
    expect(getArtistsForServer).not.toHaveBeenCalled();
    expect(getRandomSongsForServer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const result = await request;
    expect(getArtistsForServer).toHaveBeenCalledWith(
      'a', HOME_REQUEST_TIMEOUT_MS - HOME_LOCAL_READ_TIMEOUT_MS, [],
    );
    expect(getRandomSongsForServer).toHaveBeenCalledWith(
      'a', 18, undefined, HOME_REQUEST_TIMEOUT_MS - HOME_LOCAL_READ_TIMEOUT_MS, [],
    );
    expect(result.randomArtists.map(item => item.id)).toEqual(['network-artist']);
    expect(result.discoverSongs.map(item => item.id)).toEqual(['network-song']);
    vi.useRealTimers();
  });

  it('uses per-server offsets, dedupes owner-qualified ids, and advances raw cursors', async () => {
    const getAlbumListForServer = vi.fn(async (
      serverId: string,
      _type: string,
      _size: number,
      _offset: number,
      _extra: Record<string, unknown>,
      _timeout: number,
      _libraryIds?: readonly string[],
    ) => (
      serverId === 'a'
        ? [album('a', 'existing'), album('a', 'new-a')]
        : [album('b', 'existing')]
    ));
    const result = await loadMoreHomeAlbums({
      snapshot: snapshot(), section: 'starred', mixConfig,
      anchorServerId: 'a',
      scopes: [{ serverId: 'a', libraryId: 'lib-a' }, { serverId: 'b', libraryId: null }],
      deps: {
        getAlbumListForServer: getAlbumListForServer as never,
        filterAlbumsByMixRatingsAcrossServers: vi.fn(async albums => albums),
      },
    });
    expect(getAlbumListForServer.mock.calls.map(call => [call[0], call[3], call[4], call[5], call[6]]))
      .toEqual([
        ['a', 2, {}, HOME_REQUEST_TIMEOUT_MS, ['lib-a']],
        ['b', 3, {}, HOME_REQUEST_TIMEOUT_MS, []],
      ]);
    expect(result.starred.map(item => `${item.serverId}:${item.id}`))
      .toEqual(['a:existing', 'b:existing', 'a:new-a']);
    expect(result.offsets.starred).toEqual({ a: 4, b: 4 });
  });

  it('uses one global local offset for chronological pagination and never falls back', async () => {
    const getAlbumListForServer = vi.fn(async () => []);
    const libraryScopeListMainstageAlbums = vi.fn(async () => ({
      albums: [albumDto('b', 'next-2'), albumDto('a', 'next-1')],
      hasMore: false,
      genreCounts: [],
    }));
    const result = await loadMoreHomeAlbums({
      snapshot: snapshot(), section: 'recent', mixConfig,
      anchorServerId: 'a', scopes: [{ serverId: 'a', libraryId: 'lib-a' }],
      deps: {
        getAlbumListForServer: getAlbumListForServer as never,
        libraryScopeListMainstageAlbums,
        filterAlbumsByMixRatingsAcrossServers: vi.fn(async albums => albums),
      },
    });
    expect(libraryScopeListMainstageAlbums).toHaveBeenCalledWith('a', {
      scopes: [{ serverId: 'a', libraryId: 'lib-a' }],
      feed: 'newReleases',
      limit: 12,
      offset: 5,
      includeGenreCounts: false,
    });
    expect(getAlbumListForServer).not.toHaveBeenCalled();
    expect(result.recent.map(item => `${item.serverId}:${item.id}`))
      .toEqual(['b:next-2', 'a:next-1']);
    expect(result.offsets.recent).toEqual({ offset: 7, hasMore: false });
  });
});
