import { beforeEach, describe, expect, it } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { libraryGetArtistLosslessBrowse, libraryListLosslessAlbums } from './reads';
import { useAuthStore } from '@/store/authStore';

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

describe('libraryListLosslessAlbums payload', () => {
  it('keeps the single-scope payload clean (no null libraryScopes)', async () => {
    let captured: unknown;
    onInvoke('library_list_lossless_albums', (args) => {
      captured = args;
      return { source: 'local', albums: [], hasMore: false };
    });

    await libraryListLosslessAlbums({
      serverId: 'profile-s1',
      libraryScope: 'lib-a',
      limit: 30,
      offset: 0,
    });

    // `toEqual` ignores `undefined` fields but not `null`, so this fails if a
    // future edit sends `null` for the unused multi-scope field.
    expect(captured).toEqual({
      request: {
        serverId: 's1.example',
        libraryScope: 'lib-a',
        limit: 30,
        offset: 0,
      },
    });
  });

  it('forwards a multi-library ordered selection', async () => {
    let captured: unknown;
    onInvoke('library_list_lossless_albums', (args) => {
      captured = args;
      return { source: 'local', albums: [], hasMore: false };
    });

    await libraryListLosslessAlbums({
      serverId: 'profile-s1',
      libraryScopes: ['lib-a', 'lib-b'],
      limit: 30,
      offset: 0,
    });

    expect(captured).toEqual({
      request: {
        serverId: 's1.example',
        libraryScopes: ['lib-a', 'lib-b'],
        limit: 30,
        offset: 0,
      },
    });
  });
});

describe('libraryGetArtistLosslessBrowse payload', () => {
  it('keeps the single-scope payload clean (no null libraryScopes)', async () => {
    let captured: unknown;
    onInvoke('library_get_artist_lossless_browse', (args) => {
      captured = args;
      return { source: 'local', albums: [], tracks: [] };
    });

    await libraryGetArtistLosslessBrowse({
      serverId: 'profile-s1',
      artistId: 'ar-1',
      libraryScope: 'lib-a',
    });

    expect(captured).toEqual({
      request: {
        serverId: 's1.example',
        artistId: 'ar-1',
        libraryScope: 'lib-a',
      },
    });
  });
});
