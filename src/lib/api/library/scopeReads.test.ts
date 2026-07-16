import { beforeEach, describe, expect, it } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import {
  libraryScopeAlbumDetail,
  libraryScopeArtistDetail,
  libraryScopeListAlbums,
  libraryScopeListArtists,
  libraryScopeSearchTracks,
  mapScopePairs,
  scopePairsFromLibrarySelection,
  type LibraryScopePair,
} from './scopeReads';
import { useAuthStore } from '@/store/authStore';

const scopes: LibraryScopePair[] = [
  { serverId: 'profile-s1', libraryId: 'lib-a' },
  { serverId: 'profile-s1', libraryId: 'lib-b' },
];

beforeEach(() => {
  useAuthStore.setState({
    servers: [
      {
        id: 'profile-s1',
        name: 'S1',
        url: 'https://s1.example',
        username: 'u',
        password: 'p',
      },
      {
        id: 'profile-s2',
        name: 'S2',
        url: 'https://s2.example',
        username: 'u',
        password: 'p',
      },
    ],
    activeServerId: 'profile-s1',
  });
});

describe('libraryScopeListAlbums', () => {
  it('maps whole-server and exact-empty pairs without conflating them', () => {
    expect(mapScopePairs([
      { serverId: 'profile-s1', libraryId: null },
      { serverId: 'profile-s2', libraryId: '' },
    ], 'profile-s1')).toEqual([
      { serverId: 's1.example', libraryId: null },
      { serverId: 's2.example', libraryId: '' },
    ]);
  });

  it('builds a whole-server pair from an empty persisted selection', () => {
    useAuthStore.setState({
      musicLibrarySelectionByServer: { 'profile-s1': [] },
      musicLibraryFilterByServer: { 'profile-s1': 'all' },
    });
    expect(scopePairsFromLibrarySelection('profile-s1')).toEqual([
      { serverId: 's1.example', libraryId: null },
    ]);
  });

  it('invokes library_scope_list_albums with index-keyed scopes', async () => {
    let captured: unknown;
    onInvoke('library_scope_list_albums', (args) => {
      captured = args;
      return [];
    });
    await libraryScopeListAlbums('profile-s1', { scopes, limit: 50 });
    expect(captured).toEqual({
      request: {
        scopes: [
          { serverId: 's1.example', libraryId: 'lib-a' },
          { serverId: 's1.example', libraryId: 'lib-b' },
        ],
        limit: 50,
      },
    });
  });

  it('preserves returned cross-server provenance instead of using the caller fallback', async () => {
    onInvoke('library_scope_list_albums', () => [{
      serverId: 's2.example',
      id: 'al-2',
      name: 'B',
      syncedAt: 0,
      rawJson: {},
    }]);
    const albums = await libraryScopeListAlbums('profile-s1', { scopes });
    expect(albums[0]?.serverId).toBe('profile-s2');
  });

  it('uses the caller fallback only for an unknown returned index key', async () => {
    onInvoke('library_scope_list_albums', () => [{
      serverId: 'unknown-index-key',
      id: 'al-2',
      name: 'B',
      syncedAt: 0,
      rawJson: {},
    }]);
    const albums = await libraryScopeListAlbums('profile-s1', { scopes });
    expect(albums[0]?.serverId).toBe('profile-s1');
  });

  it('resolves duplicate profile/index-key aliases to the returned owner', async () => {
    useAuthStore.setState(state => ({
      servers: [
        ...state.servers,
        {
          id: 'profile-s2-alias',
          name: 'S2 alias',
          url: 'https://s2.example',
          username: 'u',
          password: 'p',
        },
      ],
      activeServerId: 'profile-s2-alias',
    }));
    onInvoke('library_scope_list_albums', () => [{
      serverId: 's2.example',
      id: 'al-2',
      name: 'B',
      syncedAt: 0,
      rawJson: {},
    }]);
    const albums = await libraryScopeListAlbums('profile-s1', { scopes });
    expect(albums[0]?.serverId).toBe('profile-s2-alias');
  });
});

describe('libraryScopeListArtists', () => {
  it('invokes library_scope_list_artists with request.scopes', async () => {
    let captured: unknown;
    onInvoke('library_scope_list_artists', (args) => {
      captured = args;
      return [];
    });
    await libraryScopeListArtists('profile-s1', { scopes });
    expect(captured).toEqual({
      request: {
        scopes: [
          { serverId: 's1.example', libraryId: 'lib-a' },
          { serverId: 's1.example', libraryId: 'lib-b' },
        ],
      },
    });
  });

  it('preserves returned cross-server artist provenance', async () => {
    onInvoke('library_scope_list_artists', () => [{
      serverId: 's2.example',
      id: 'ar-2',
      name: 'Artist B',
      syncedAt: 0,
      rawJson: {},
    }]);
    const artists = await libraryScopeListArtists('profile-s1', { scopes });
    expect(artists[0]?.serverId).toBe('profile-s2');
  });
});

describe('libraryScopeSearchTracks', () => {
  it('invokes library_scope_search_tracks with query and scopes', async () => {
    let captured: unknown;
    onInvoke('library_scope_search_tracks', (args) => {
      captured = args;
      return [];
    });
    await libraryScopeSearchTracks('profile-s1', { scopes, query: 'foo', limit: 20 });
    expect(captured).toEqual({
      request: {
        scopes: [
          { serverId: 's1.example', libraryId: 'lib-a' },
          { serverId: 's1.example', libraryId: 'lib-b' },
        ],
        query: 'foo',
        limit: 20,
      },
    });
  });
});

describe('libraryScopeAlbumDetail', () => {
  it('invokes library_scope_album_detail with mapped anchor server id', async () => {
    let captured: unknown;
    onInvoke('library_scope_album_detail', (args) => {
      captured = args;
      return {
        album: {
          serverId: 's1.example',
          id: 'al-1',
          name: 'A',
          syncedAt: 0,
          rawJson: {},
        },
        tracks: [],
      };
    });
    await libraryScopeAlbumDetail('profile-s1', {
      scopes,
      albumId: 'al-1',
      serverId: 'profile-s1',
    });
    expect(captured).toEqual({
      request: {
        scopes: [
          { serverId: 's1.example', libraryId: 'lib-a' },
          { serverId: 's1.example', libraryId: 'lib-b' },
        ],
        albumId: 'al-1',
        serverId: 's1.example',
      },
    });
  });
});

describe('libraryScopeArtistDetail', () => {
  it('invokes library_scope_artist_detail with mapped anchor server id', async () => {
    let captured: unknown;
    onInvoke('library_scope_artist_detail', (args) => {
      captured = args;
      return {
        artist: {
          serverId: 's1.example',
          id: 'ar-1',
          name: 'Artist',
          syncedAt: 0,
          rawJson: {},
        },
        albums: [],
        tracks: [],
      };
    });
    await libraryScopeArtistDetail('profile-s1', {
      scopes,
      artistId: 'ar-1',
      serverId: 'profile-s1',
    });
    expect(captured).toEqual({
      request: {
        scopes: [
          { serverId: 's1.example', libraryId: 'lib-a' },
          { serverId: 's1.example', libraryId: 'lib-b' },
        ],
        artistId: 'ar-1',
        serverId: 's1.example',
      },
    });
  });
});
