/**
 * Subsonic API contract tests (Phase F3).
 *
 * Pins the URL-builder shapes (`buildStreamUrl`, `buildCoverArtUrl`,
 * `buildDownloadUrl`, `coverArtCacheKey`) plus the small pure parsers
 * (`parseSubsonicEntityStarRating`, `libraryFilterParams`,
 * `getClient`) — the surface the rest of the frontend uses to talk to
 * Subsonic / Navidrome.
 *
 * Network-bound endpoints (`getAlbum`, `search`, etc.) require axios
 * mocking and are not in this PR.
 */
import {
  buildCoverArtUrl,
  buildCoverArtUrlForServer,
  buildDownloadUrl,
  buildStreamUrl,
  coverArtCacheKey,
  coverArtCacheKeyForServer,
} from '@/lib/api/subsonicStreamUrl';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseSubsonicEntityStarRating } from '@/lib/api/subsonicRatings';
import { getClient, libraryFilterParams, libraryFilterParamsForServer, libraryScopeCacheKeyForServer, libraryScopeForServer, libraryScopeIsActive, libraryScopePairsForServer, librarySelectionForServer } from '@/lib/api/subsonicClient';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';

function setUpServer(overrides: { url?: string; username?: string; password?: string } = {}): string {
  const id = useAuthStore.getState().addServer({
    name: 'Test',
    url: overrides.url ?? 'https://music.example.com',
    username: overrides.username ?? 'alice',
    password: overrides.password ?? 'pw',
  });
  useAuthStore.getState().setActiveServer(id);
  return id;
}

beforeEach(() => {
  resetAuthStore();
});

describe('parseSubsonicEntityStarRating', () => {
  it('reads userRating first, falls back to rating', () => {
    expect(parseSubsonicEntityStarRating({ userRating: 4 })).toBe(4);
    expect(parseSubsonicEntityStarRating({ rating: 3 })).toBe(3);
    expect(parseSubsonicEntityStarRating({ userRating: 5, rating: 2 })).toBe(5);
  });

  it('coerces numeric strings', () => {
    expect(parseSubsonicEntityStarRating({ userRating: '4' as unknown as number })).toBe(4);
    expect(parseSubsonicEntityStarRating({ rating: '3.5' as unknown as number })).toBe(3.5);
  });

  it('returns undefined for null / undefined / non-numeric values', () => {
    expect(parseSubsonicEntityStarRating({})).toBeUndefined();
    expect(parseSubsonicEntityStarRating({ userRating: null as unknown as number })).toBeUndefined();
    expect(parseSubsonicEntityStarRating({ rating: 'nope' as unknown as number })).toBeUndefined();
    expect(parseSubsonicEntityStarRating({ userRating: Number.NaN })).toBeUndefined();
  });
});

describe('libraryFilterParams', () => {
  it('returns an empty object when no server is active', () => {
    expect(libraryFilterParams()).toEqual({});
  });

  it('returns an empty object when the filter is "all" or unset', () => {
    setUpServer();
    expect(libraryFilterParams()).toEqual({});
  });

  it('returns { musicFolderId } when the active server has a specific filter', () => {
    const serverId = setUpServer();
    useAuthStore.setState({
      musicLibraryFilterByServer: { [serverId]: 'mf-7' },
    });
    expect(libraryFilterParams()).toEqual({ musicFolderId: 'mf-7' });
  });

  it('returns repeated musicFolderId values for multi-library selection', () => {
    const serverId = setUpServer();
    useAuthStore.getState().setMusicLibrarySelection(['mf-2', 'mf-7']);
    expect(libraryFilterParams()).toEqual({ musicFolderId: ['mf-2', 'mf-7'] });
    expect(libraryFilterParamsForServer(serverId)).toEqual({ musicFolderId: ['mf-2', 'mf-7'] });
  });
});

describe('librarySelectionForServer', () => {
  it('migrates legacy all or absent to empty array', () => {
    const serverId = setUpServer();
    expect(librarySelectionForServer(serverId)).toEqual([]);
    useAuthStore.setState({
      musicLibraryFilterByServer: { [serverId]: 'all' },
    });
    expect(librarySelectionForServer(serverId)).toEqual([]);
  });

  it('migrates legacy single id to one-element array', () => {
    const serverId = setUpServer();
    useAuthStore.setState({
      musicLibraryFilterByServer: { [serverId]: 'mf-7' },
    });
    expect(librarySelectionForServer(serverId)).toEqual(['mf-7']);
  });

  it('returns ordered selection when the new map has an entry', () => {
    const serverId = setUpServer();
    useAuthStore.setState({
      musicLibrarySelectionByServer: { [serverId]: ['lib-b', 'lib-a'] },
      musicLibraryFilterByServer: { [serverId]: 'lib-b' },
    });
    expect(librarySelectionForServer(serverId)).toEqual(['lib-b', 'lib-a']);
  });
});

describe('libraryScopeForServer', () => {
  it('returns undefined for all or unset filters', () => {
    const serverId = setUpServer();
    expect(libraryScopeForServer(serverId)).toBeUndefined();
    useAuthStore.setState({
      musicLibraryFilterByServer: { [serverId]: 'all' },
    });
    expect(libraryScopeForServer(serverId)).toBeUndefined();
  });

  it('returns the folder id when scoped', () => {
    const serverId = setUpServer();
    useAuthStore.setState({
      musicLibraryFilterByServer: { [serverId]: 'mf-7' },
    });
    expect(libraryScopeForServer(serverId)).toBe('mf-7');
  });

  it('returns undefined when multiple libraries are selected', () => {
    const serverId = setUpServer();
    useAuthStore.getState().setMusicLibrarySelection(['mf-2', 'mf-7']);
    expect(libraryScopeForServer(serverId)).toBeUndefined();
    expect(libraryScopeIsActive(serverId)).toBe(true);
    expect(libraryScopeCacheKeyForServer(serverId)).toBe('mf-2,mf-7');
  });
});

describe('libraryScopePairsForServer', () => {
  it('returns a whole-server pair when all libraries or unset', () => {
    const serverId = setUpServer();
    expect(libraryScopePairsForServer(serverId)).toEqual([{ serverId, libraryId: null }]);
    useAuthStore.setState({
      musicLibraryFilterByServer: { [serverId]: 'all' },
    });
    expect(libraryScopePairsForServer(serverId)).toEqual([{ serverId, libraryId: null }]);
  });

  it('returns one ordered pair for legacy single-library filter', () => {
    const serverId = setUpServer();
    useAuthStore.setState({
      musicLibraryFilterByServer: { [serverId]: 'mf-7' },
    });
    expect(libraryScopePairsForServer(serverId)).toEqual([
      { serverId, libraryId: 'mf-7' },
    ]);
  });

  it('returns ordered pairs from multi-library selection', () => {
    const serverId = setUpServer();
    useAuthStore.setState({
      musicLibrarySelectionByServer: { [serverId]: ['lib-b', 'lib-a'] },
      musicLibraryFilterByServer: { [serverId]: 'lib-b' },
    });
    expect(libraryScopePairsForServer(serverId)).toEqual([
      { serverId, libraryId: 'lib-b' },
      { serverId, libraryId: 'lib-a' },
    ]);
  });
});

describe('librarySelectionForServer — collapse when all libraries selected', () => {
  it('collapses to the all-libraries scope when every folder is selected', () => {
    const serverId = setUpServer();
    useAuthStore.setState({
      musicFolders: [
        { id: 'mf-1', name: 'A' },
        { id: 'mf-2', name: 'B' },
      ],
    });
    useAuthStore.getState().setMusicLibrarySelection(['mf-1', 'mf-2']);
    expect(librarySelectionForServer(serverId)).toEqual([]);
    expect(libraryScopeIsActive(serverId)).toBe(false);
    expect(libraryScopeCacheKeyForServer(serverId)).toBe('all');
    expect(libraryScopePairsForServer(serverId)).toEqual([{ serverId, libraryId: null }]);
    expect(libraryFilterParamsForServer(serverId)).toEqual({});
  });

  it('keeps the scope when only a subset is selected', () => {
    const serverId = setUpServer();
    useAuthStore.setState({
      musicFolders: [
        { id: 'mf-1', name: 'A' },
        { id: 'mf-2', name: 'B' },
      ],
    });
    useAuthStore.getState().setMusicLibrarySelection(['mf-1']);
    expect(librarySelectionForServer(serverId)).toEqual(['mf-1']);
    expect(libraryScopeIsActive(serverId)).toBe(true);
    expect(libraryScopeCacheKeyForServer(serverId)).toBe('mf-1');
  });

  it('does not collapse when the folder list is not yet loaded', () => {
    const serverId = setUpServer();
    useAuthStore.getState().setMusicLibrarySelection(['mf-1', 'mf-2']);
    expect(librarySelectionForServer(serverId)).toEqual(['mf-1', 'mf-2']);
  });
});

describe('getClient', () => {
  it('throws when no server is configured', () => {
    expect(() => getClient()).toThrow(/no server configured/i);
  });

  it('returns baseUrl + auth params shape from the active server', () => {
    setUpServer({ url: 'https://music.example.com', username: 'alice', password: 'pw' });
    const { baseUrl, params } = getClient();
    expect(baseUrl).toBe('https://music.example.com/rest');
    expect(params).toMatchObject({
      u: 'alice',
      v: '1.16.1',
      f: 'json',
    });
    expect(params.c).toMatch(/^psysonic\//);
    expect(typeof params.t).toBe('string');
    expect(params.t).toHaveLength(32); // md5 hex
    expect(typeof params.s).toBe('string');
    expect((params.s as string).length).toBeGreaterThan(0);
  });

  it('rotates token + salt across calls (random per request)', () => {
    setUpServer();
    const a = getClient();
    const b = getClient();
    expect(a.params.t).not.toBe(b.params.t);
    expect(a.params.s).not.toBe(b.params.s);
  });
});

describe('coverArtCacheKey', () => {
  it('uses host index key + entity id + tier as a stable cache key', () => {
    setUpServer();
    expect(coverArtCacheKey('cover-1')).toBe('music.example.com:cover:album:cover-1:256');
    expect(coverArtCacheKey('cover-1', 200)).toBe('music.example.com:cover:album:cover-1:200');
  });

  it('falls back to "_" as the server-id segment when no server is active', () => {
    expect(coverArtCacheKey('cover-99')).toBe('_:cover:album:cover-99:256');
  });

  it('does not embed the ephemeral salt or token — keys stay cacheable across calls', () => {
    setUpServer();
    const a = coverArtCacheKey('art-1', 256);
    const b = coverArtCacheKey('art-1', 256);
    expect(a).toBe(b);
  });
});

describe('buildStreamUrl', () => {
  it('returns a /rest/stream.view URL on the configured base URL', () => {
    setUpServer({ url: 'https://music.example.com', username: 'alice', password: 'pw' });
    const url = new URL(buildStreamUrl('track-1'));
    expect(url.origin).toBe('https://music.example.com');
    expect(url.pathname).toBe('/rest/stream.view');
  });

  it('carries the stable Subsonic auth params (id, u, t, s, v, c, f)', () => {
    setUpServer({ url: 'https://music.example.com', username: 'alice', password: 'pw' });
    const url = new URL(buildStreamUrl('track-1'));
    expect(url.searchParams.get('id')).toBe('track-1');
    expect(url.searchParams.get('u')).toBe('alice');
    expect(url.searchParams.get('v')).toBe('1.16.1');
    expect(url.searchParams.get('f')).toBe('json');
    expect(url.searchParams.get('c')?.startsWith('psysonic/')).toBe(true);
    expect(url.searchParams.get('t')).toHaveLength(32); // md5 hex
    expect(url.searchParams.get('s')).toBeTruthy();
  });

  it('rotates t/s across calls — Rust matches playback identity by id, not by URL', () => {
    setUpServer();
    const a = new URL(buildStreamUrl('track-1'));
    const b = new URL(buildStreamUrl('track-1'));
    expect(a.searchParams.get('id')).toBe(b.searchParams.get('id'));
    expect(a.searchParams.get('t')).not.toBe(b.searchParams.get('t'));
    expect(a.searchParams.get('s')).not.toBe(b.searchParams.get('s'));
  });

  it('URL-encodes ids with special characters once (not double-encoded)', () => {
    setUpServer();
    const id = 'AC/DC — Back in Black';
    const url = new URL(buildStreamUrl(id));
    expect(url.searchParams.get('id')).toBe(id);
  });
});

describe('buildCoverArtUrl', () => {
  it('returns a /rest/getCoverArt.view URL with size param', () => {
    setUpServer({ url: 'https://music.example.com' });
    const url = new URL(buildCoverArtUrl('cover-1', 512));
    expect(url.pathname).toBe('/rest/getCoverArt.view');
    expect(url.searchParams.get('id')).toBe('cover-1');
    expect(url.searchParams.get('size')).toBe('512');
  });

  it('defaults size to 256 when omitted', () => {
    setUpServer();
    const url = new URL(buildCoverArtUrl('cover-1'));
    expect(url.searchParams.get('size')).toBe('256');
  });
});

describe('buildCoverArtUrlForServer', () => {
  it('builds getCoverArt URL with explicit server credentials', () => {
    const url = new URL(buildCoverArtUrlForServer('https://remote.example', 'bob', 'secret', 'art-9', 40));
    expect(url.origin).toBe('https://remote.example');
    expect(url.pathname).toBe('/rest/getCoverArt.view');
    expect(url.searchParams.get('id')).toBe('art-9');
    expect(url.searchParams.get('size')).toBe('40');
    expect(url.searchParams.get('u')).toBe('bob');
    expect(url.searchParams.get('t')).toBeTruthy();
  });
});

describe('coverArtCacheKeyForServer', () => {
  it('scopes cache keys by host index key when profile is known', () => {
    const profileId = setUpServer({ url: 'https://b.example' });
    expect(coverArtCacheKeyForServer(profileId, 'cover-1', 80)).toBe('b.example:cover:album:cover-1:80');
  });
});

describe('buildDownloadUrl', () => {
  it('returns a /rest/download.view URL with id + auth params', () => {
    setUpServer({ url: 'https://music.example.com' });
    const url = new URL(buildDownloadUrl('track-7'));
    expect(url.pathname).toBe('/rest/download.view');
    expect(url.searchParams.get('id')).toBe('track-7');
    expect(url.searchParams.get('v')).toBe('1.16.1');
  });
});

describe('URL builders — trailing-slash + scheme handling on base URL', () => {
  it('strips trailing slash from base URL (getBaseUrl normalises)', () => {
    setUpServer({ url: 'https://music.example.com/' });
    const url = new URL(buildStreamUrl('t1'));
    expect(url.origin).toBe('https://music.example.com');
    // No `//rest` doubled-slash:
    expect(url.pathname).toBe('/rest/stream.view');
  });

  it('prepends http:// when the configured URL lacks a scheme', () => {
    setUpServer({ url: 'music.local' });
    const url = new URL(buildStreamUrl('t1'));
    expect(url.protocol).toBe('http:');
    expect(url.host).toBe('music.local');
  });
});
