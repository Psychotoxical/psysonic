import { beforeEach, describe, expect, it } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import {
  libraryScopeAlbumDetail,
  libraryScopeArtistDetail,
  libraryScopeListAlbums,
  libraryScopeListArtists,
  libraryScopeSearchTracks,
  libraryScopeCatalogStatistics,
  libraryScopeMostPlayedAlbums,
  libraryScopeListArtistsByRole,
  libraryResolveEntitySources,
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
    const aliasScopes = [{ serverId: 'profile-s2', libraryId: null }];
    const albums = await libraryScopeListAlbums('profile-s1', { scopes: aliasScopes });
    expect(albums[0]?.serverId).toBe('profile-s2');

    useAuthStore.setState({ activeServerId: 'profile-s2' });
    const afterActiveAliasChange = await libraryScopeListAlbums('profile-s1', { scopes: aliasScopes });
    expect(afterActiveAliasChange[0]?.serverId).toBe('profile-s2');
  });

  it('maps resolved sources to the selected common-order owner even when its alias is active', async () => {
    useAuthStore.setState({
      servers: [
        {
          id: 'owner', name: 'Owner', url: 'https://same.example', username: 'u', password: 'p',
        },
        {
          id: 'alias', name: 'Alias', url: 'http://same.example/', username: 'u', password: 'p',
        },
      ],
      activeServerId: 'alias',
      musicLibraryServerIds: ['alias', 'owner'],
    });
    onInvoke('library_resolve_entity_sources', () => [
      { serverId: 'same.example', id: 'track-owner', libraryId: 'one', priority: 0 },
    ]);

    const sources = await libraryResolveEntitySources('owner', {
      entityType: 'track',
      anchorServerId: 'owner',
      anchorId: 'track-owner',
      scopes: [{ serverId: 'owner', libraryId: 'one' }],
    });
    expect(sources[0]?.serverId).toBe('owner');
  });

  it('coalesces duplicate profile scopes before IPC with all-libraries dominance', async () => {
    useAuthStore.setState(state => ({
      servers: [
        ...state.servers,
        {
          id: 'profile-s1-alias',
          name: 'S1 alias',
          url: 'http://s1.example/',
          username: 'u',
          password: 'p',
        },
      ],
    }));
    let captured: unknown;
    onInvoke('library_scope_list_albums', args => {
      captured = args;
      return [];
    });
    await libraryScopeListAlbums('profile-s1', {
      scopes: [
        { serverId: 'profile-s1', libraryId: 'lib-a' },
        { serverId: 'profile-s1-alias', libraryId: 'lib-b' },
        { serverId: 'profile-s1-alias', libraryId: null },
      ],
    });
    expect(captured).toEqual({
      request: { scopes: [{ serverId: 's1.example', libraryId: null }] },
    });
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

describe('scope statistics reads', () => {
  it('maps catalog-statistics scope pairs to index keys', async () => {
    let captured: unknown;
    onInvoke('library_scope_catalog_statistics', args => {
      captured = args;
      return {
        artistCount: 0,
        albumCount: 0,
        trackCount: 0,
        durationSec: 0,
        genres: [],
        formats: [],
        formatSampleSize: 0,
      };
    });
    await libraryScopeCatalogStatistics('profile-s1', { scopes, formatSampleLimit: 500 });
    expect(captured).toEqual({
      request: {
        scopes: [
          { serverId: 's1.example', libraryId: 'lib-a' },
          { serverId: 's1.example', libraryId: 'lib-b' },
        ],
        formatSampleLimit: 500,
      },
    });
  });

  it('maps Most Played album provenance from the concrete priority winner', async () => {
    onInvoke('library_scope_most_played_albums', () => [{
      album: {
        serverId: 's2.example',
        id: 'album-2',
        name: 'Album',
        syncedAt: 1,
        rawJson: {},
      },
      playCount: 3,
    }]);
    const rows = await libraryScopeMostPlayedAlbums('profile-s1', { scopes, limit: 10 });
    expect(rows[0]?.album.serverId).toBe('profile-s2');
    expect(rows[0]?.playCount).toBe(3);
  });

  it('maps composer-role reads and preserves artist provenance', async () => {
    let captured: unknown;
    onInvoke('library_scope_list_artists_by_role', args => {
      captured = args;
      return [{ serverId: 's2.example', id: 'composer-2', name: 'Composer', syncedAt: 1, rawJson: {} }];
    });
    const artists = await libraryScopeListArtistsByRole('profile-s1', {
      scopes,
      role: 'composer',
      limit: 100,
    });
    expect(captured).toEqual({
      request: {
        scopes: [
          { serverId: 's1.example', libraryId: 'lib-a' },
          { serverId: 's1.example', libraryId: 'lib-b' },
        ],
        role: 'composer',
        limit: 100,
      },
    });
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

describe('libraryResolveEntitySources', () => {
  it('maps the concrete anchor and ordered scopes to index keys', async () => {
    let captured: unknown;
    onInvoke('library_resolve_entity_sources', (args) => {
      captured = args;
      return [];
    });
    await libraryResolveEntitySources('profile-s1', {
      entityType: 'track',
      anchorServerId: 'profile-s2',
      anchorId: 'track-2',
      scopes: [
        { serverId: 'profile-s2', libraryId: null },
        { serverId: 'profile-s1', libraryId: 'lib-a' },
      ],
    });
    expect(captured).toEqual({
      request: {
        entityType: 'track',
        anchorServerId: 's2.example',
        anchorId: 'track-2',
        scopes: [
          { serverId: 's2.example', libraryId: null },
          { serverId: 's1.example', libraryId: 'lib-a' },
        ],
      },
    });
  });

  it('preserves source order and maps each concrete server provenance', async () => {
    onInvoke('library_resolve_entity_sources', () => [
      {
        serverId: 's2.example',
        id: 'track-2',
        libraryId: '',
        priority: 0,
        durationSec: 104,
        suffix: 'flac',
        bitRate: 1000,
        sizeBytes: 30000000,
        starredAt: null,
        userRating: 5,
      },
      {
        serverId: 's1.example',
        id: 'track-1',
        libraryId: 'lib-a',
        priority: 1,
        durationSec: 104,
        suffix: 'mp3',
        bitRate: 320,
        sizeBytes: 8000000,
        starredAt: null,
        userRating: null,
      },
    ]);

    const sources = await libraryResolveEntitySources('profile-s1', {
      entityType: 'track',
      anchorServerId: 'profile-s1',
      anchorId: 'track-1',
      scopes,
    });

    expect(sources.map(source => [source.serverId, source.id, source.priority])).toEqual([
      ['profile-s2', 'track-2', 0],
      ['profile-s1', 'track-1', 1],
    ]);
    expect(sources[0]).not.toHaveProperty('clusterKey');
  });
});
