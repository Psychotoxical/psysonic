import { beforeEach, describe, expect, it } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import {
  libraryScopeAlbumDetail,
  libraryScopeArtistDetail,
  libraryScopeListAlbums,
  libraryScopeListArtists,
  libraryScopeSearchTracks,
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
    ],
    activeServerId: 'profile-s1',
  });
});

describe('libraryScopeListAlbums', () => {
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
