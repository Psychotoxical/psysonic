import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicAlbum, SubsonicSong } from '@/lib/api/subsonicTypes';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { resetPlayerStore } from '@/test/helpers/storeReset';

vi.mock('@/lib/api/subsonicRatings', () => ({
  entityUserRatingKey: ({ serverId, entityKind, entityId }: { serverId: string; entityKind: string; entityId: string }) => `${serverId}\u0001${entityKind}\u0001${entityId}`,
  putLocalEntityUserRatings: vi.fn(),
  resolveEntityUserRatings: vi.fn(),
  parseSubsonicEntityStarRating: vi.fn((entity: { userRating?: unknown; rating?: unknown }) => entity.userRating ?? entity.rating),
}));
vi.mock('@/store/authStore', () => ({ useAuthStore: { getState: () => ({ activeServerId: 'server-a' }) } }));

import { putLocalEntityUserRatings, resolveEntityUserRatings } from '@/lib/api/subsonicRatings';
import {
  enrichSongsForMixRatingFilter,
  filterAlbumsByMixRatingsAcrossServers,
  filterTopArtistsForMixRatings,
  passesMixMinRatings,
} from '@/features/playback/utils/mixRatingFilter';

const enabledArtist2: { enabled: true; minSong: 0; minAlbum: 0; minArtist: 2 } = {
  enabled: true, minSong: 0, minAlbum: 0, minArtist: 2,
};

function song(partial: Partial<SubsonicSong> & Pick<SubsonicSong, 'id'>): SubsonicSong {
  return { title: 't', artist: 'A', album: 'Al', albumId: 'alb-1', artistId: 'art-1', duration: 180, ...partial };
}

function album(partial: Pick<SubsonicAlbum, 'id' | 'name' | 'artistId'> & { serverId: string }): SubsonicAlbum & { serverId: string } {
  return { artist: 'Artist', songCount: 1, duration: 180, ...partial };
}

beforeEach(() => {
  resetPlayerStore();
  vi.mocked(resolveEntityUserRatings).mockReset();
  vi.mocked(resolveEntityUserRatings).mockResolvedValue(new Map());
  vi.mocked(putLocalEntityUserRatings).mockReset();
});

describe('filterAlbumsByMixRatingsAcrossServers', () => {
  it('uses owner-scoped local ratings and preserves merged order', async () => {
    const config = { enabled: true, minSong: 0, minAlbum: 2, minArtist: 2 };
    const albums: Array<SubsonicAlbum & { serverId: string }> = [
      album({ id: 'shared', name: 'A shared', artistId: 'artist-a', serverId: 'server-a' }),
      album({ id: 'keep-b', name: 'B keep', artistId: 'artist-b', serverId: 'server-b' }),
      album({ id: 'keep-a', name: 'A keep', artistId: 'artist-a2', serverId: 'server-a' }),
      album({ id: 'shared', name: 'B shared', artistId: 'artist-b2', serverId: 'server-b' }),
    ];
    vi.mocked(resolveEntityUserRatings).mockResolvedValue(new Map([
      ['server-a\u0001album\u0001shared', 1], ['server-a\u0001album\u0001keep-a', 4],
      ['server-b\u0001album\u0001keep-b', 4], ['server-b\u0001album\u0001shared', 5],
      ['server-a\u0001artist\u0001artist-a', 5], ['server-a\u0001artist\u0001artist-a2', 5],
      ['server-b\u0001artist\u0001artist-b', 5], ['server-b\u0001artist\u0001artist-b2', 5],
    ]));

    const result = await filterAlbumsByMixRatingsAcrossServers(albums, config);

    expect(result.map(item => `${item.serverId}:${item.id}`)).toEqual([
      'server-b:keep-b', 'server-a:keep-a', 'server-b:shared',
    ]);
    expect(resolveEntityUserRatings).toHaveBeenCalledTimes(1);
  });

  it('persists payload ratings in one batch instead of one invoke per album', async () => {
    const albums: Array<SubsonicAlbum & { serverId: string }> = [
      { ...album({ id: 'a', name: 'A', artistId: 'aa', serverId: 'server-a' }), userRating: 3 },
      { ...album({ id: 'b', name: 'B', artistId: 'bb', serverId: 'server-b' }), userRating: 5 },
    ];

    await filterAlbumsByMixRatingsAcrossServers(
      albums,
      { enabled: true, minSong: 0, minAlbum: 1, minArtist: 0 },
    );

    expect(putLocalEntityUserRatings).toHaveBeenCalledTimes(1);
    expect(putLocalEntityUserRatings).toHaveBeenCalledWith([
      { serverId: 'server-a', entityKind: 'album', entityId: 'a', rating: 3 },
      { serverId: 'server-b', entityKind: 'album', entityId: 'b', rating: 5 },
    ]);
  });
});

describe('passesMixMinRatings - artist axis', () => {
  it('excludes ratings at or below the threshold and keeps unrated artists', () => {
    expect(passesMixMinRatings(song({ id: '1', artistUserRating: 1 }), enabledArtist2)).toBe(false);
    expect(passesMixMinRatings(song({ id: '2', artistUserRating: 2 }), enabledArtist2)).toBe(false);
    expect(passesMixMinRatings(song({ id: '3', artistUserRating: 3 }), enabledArtist2)).toBe(true);
    expect(passesMixMinRatings(song({ id: '4' }), enabledArtist2)).toBe(true);
  });

  it('uses optimistic overrides before API fields', () => {
    usePlayerStore.getState().setUserRatingOverride('art-1', 1);
    expect(passesMixMinRatings(song({ id: '1', artistUserRating: 5 }), enabledArtist2)).toBe(false);
  });
});

describe('enrichSongsForMixRatingFilter', () => {
  it('uses a local resolved rating when the song payload omits one', async () => {
    vi.mocked(resolveEntityUserRatings).mockResolvedValue(new Map([['server-a\u0001artist\u0001art-1', 1]]));
    const out = await enrichSongsForMixRatingFilter([song({ id: '1' })], enabledArtist2);

    expect(out[0].artistUserRating).toBe(1);
    expect(passesMixMinRatings(out[0], enabledArtist2)).toBe(false);
  });

  it('keeps a payload rating ahead of a local cache value', async () => {
    vi.mocked(resolveEntityUserRatings).mockResolvedValue(new Map([['server-a\u0001artist\u0001art-1', 1]]));
    const out = await enrichSongsForMixRatingFilter([song({ id: '1', artistUserRating: 5 })], enabledArtist2);

    expect(out[0].artistUserRating).toBe(5);
    expect(passesMixMinRatings(out[0], enabledArtist2)).toBe(true);
  });

  it('uses and stamps the explicit owner instead of the active server', async () => {
    vi.mocked(resolveEntityUserRatings).mockResolvedValue(new Map([
      ['server-b\u0001artist\u0001art-1', 1],
    ]));

    const out = await enrichSongsForMixRatingFilter(
      [song({ id: '1' })],
      enabledArtist2,
      'server-b',
    );

    expect(resolveEntityUserRatings).toHaveBeenCalledWith([
      { serverId: 'server-b', entityKind: 'artist', entityId: 'art-1' },
    ]);
    expect(out[0]).toEqual(expect.objectContaining({
      serverId: 'server-b',
      artistUserRating: 1,
    }));
  });
});

describe('filterTopArtistsForMixRatings', () => {
  it('drops local ratings at or below the threshold', async () => {
    vi.mocked(resolveEntityUserRatings).mockResolvedValue(new Map([
      ['server-a\u0001artist\u0001a1', 1], ['server-a\u0001artist\u0001a2', 3],
    ]));
    const out = await filterTopArtistsForMixRatings([
      { id: 'a1', name: 'Low' }, { id: 'a2', name: 'Ok' }, { id: 'a3', name: 'Unrated' },
    ], enabledArtist2);
    expect(out.map(item => item.id)).toEqual(['a2', 'a3']);
  });
});
