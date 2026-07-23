import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryAlbumDto, LibraryArtistDto, LibraryTrackDto } from '@/lib/api/library/dto';

const libraryScopeArtistDetailMock = vi.fn();

vi.mock('@/lib/api/library/scopeReads', () => ({
  libraryScopeArtistDetail: (...args: unknown[]) => libraryScopeArtistDetailMock(...args),
}));

import { tryLoadArtistDetailMultiScope } from './loadArtistDetailMultiScope';

function artistDto(overrides: Partial<LibraryArtistDto> = {}): LibraryArtistDto {
  return {
    serverId: 'srv-1',
    id: 'art-1',
    name: 'Merged Artist',
    albumCount: 1,
    syncedAt: 0,
    rawJson: {},
    ...overrides,
  };
}

function albumDto(overrides: Partial<LibraryAlbumDto> = {}): LibraryAlbumDto {
  return {
    serverId: 'srv-1',
    id: 'alb-1',
    name: 'Album',
    artist: 'Merged Artist',
    artistId: 'art-1',
    songCount: 1,
    durationSec: 200,
    syncedAt: 0,
    rawJson: {},
    ...overrides,
  };
}

function trackDto(overrides: Partial<LibraryTrackDto> = {}): LibraryTrackDto {
  return {
    serverId: 'srv-1',
    id: 'trk-1',
    title: 'Hit',
    album: 'Album',
    albumId: 'alb-1',
    artistId: 'art-1',
    durationSec: 200,
    playCount: 3,
    syncedAt: 0,
    rawJson: {},
    ...overrides,
  };
}

describe('tryLoadArtistDetailMultiScope', () => {
  beforeEach(() => {
    libraryScopeArtistDetailMock.mockReset();
  });

  it('maps scope artist detail and sorts top songs by playCount desc', async () => {
    libraryScopeArtistDetailMock.mockResolvedValue({
      artist: artistDto(),
      albums: [albumDto()],
      tracks: [
        trackDto({ id: 'low', playCount: 1 }),
        trackDto({ id: 'high', playCount: 99 }),
      ],
      topTracksServerId: 'srv-2',
      topTracksFingerprint: 'tracks-v1',
    });

    const scopes = [
      { serverId: 'srv-1', libraryId: 'lib-a' },
      { serverId: 'srv-2', libraryId: 'lib-b' },
    ];
    const result = await tryLoadArtistDetailMultiScope(scopes, 'srv-1', 'art-1');

    expect(libraryScopeArtistDetailMock).toHaveBeenCalledWith('srv-1', {
      scopes: [
        { serverId: 'srv-1', libraryId: 'lib-a' },
        { serverId: 'srv-2', libraryId: 'lib-b' },
      ],
      artistId: 'art-1',
      serverId: 'srv-1',
      topTracksLimit: 5,
    });
    expect(result?.artist).toMatchObject({ id: 'art-1', name: 'Merged Artist' });
    expect(result?.albums).toHaveLength(1);
    expect(result?.topSongs.map(s => s.id)).toEqual(['high', 'low']);
    expect(result?.topTracksServerId).toBe('srv-2');
    expect(result?.topTracksFingerprint).toBe('tracks-v1');
  });

  it('returns null when the merged artist anchor is missing', async () => {
    libraryScopeArtistDetailMock.mockResolvedValue({
      artist: artistDto({ id: '' }),
      albums: [],
      tracks: [],
    });

    await expect(tryLoadArtistDetailMultiScope([], 'srv-1', 'art-1')).resolves.toBeNull();
  });

  it('maps a Various Artists payload whose albums are label-linked only', async () => {
    // The VA entity has no track carrying its performer id, so the backend seeds the
    // header from the artist row. If that header ever came back with an empty id, the
    // loader would discard the whole payload and the artist hook would stop without a
    // network fallback — the compilations would be unreachable in the app.
    libraryScopeArtistDetailMock.mockResolvedValue({
      artist: artistDto({ id: 'va', name: 'Various Artists' }),
      albums: [albumDto({ id: 'comp1', name: 'Comp One', artistId: 'va' })],
      tracks: [],
    });

    const result = await tryLoadArtistDetailMultiScope([], 'srv-1', 'va');

    expect(result).not.toBeNull();
    expect(result?.artist.id).toBe('va');
    expect(result?.albums.map(a => a.id)).toEqual(['comp1']);
  });

  it('returns null when the scope command throws', async () => {
    libraryScopeArtistDetailMock.mockRejectedValue(new Error('ipc fail'));

    await expect(tryLoadArtistDetailMultiScope([], 'srv-1', 'art-1')).resolves.toBeNull();
  });
});
