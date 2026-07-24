import { beforeEach, describe, expect, it, vi } from 'vitest';

const coverCachePeekBatch = vi.hoisted(() => vi.fn(async (_refs: unknown[]) => ({})));
const resolveAlbumCoverRefFromLibrary = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/coverCache', () => ({ coverCachePeekBatch }));
vi.mock('./diskSrcLookup', () => ({
  getDiskSrcForGrid: () => 'disk://hit',
  rememberGridDiskSrc: vi.fn(() => true),
}));
vi.mock('./ensureQueue', () => ({
  coverEnsureQueued: vi.fn(),
  ensureArtistBackdropQueued: vi.fn(),
}));
vi.mock('./serverScope', () => ({
  coverServerScopeForServerId: (serverId?: string) => serverId
    ? {
        kind: 'server',
        serverId,
        url: `https://${serverId}.test`,
        username: serverId,
        password: 'secret',
      }
    : { kind: 'active' },
  coverServerScopeForOwnerServerId: (serverId: string) => ({
    kind: 'server',
    serverId,
    url: `https://${serverId}.test`,
    username: serverId,
    password: 'secret',
  }),
}));
vi.mock('./resolveEntryLibrary', () => ({
  resolveAlbumCoverRefFromLibrary,
}));

import {
  collectAlbumCoverWarmItems,
  warmHomeMainstageCovers,
  warmUniqueAlbumCoversFromLibrary,
} from './warmDiskPeek';

describe('warmHomeMainstageCovers', () => {
  beforeEach(() => {
    coverCachePeekBatch.mockClear();
    resolveAlbumCoverRefFromLibrary.mockClear();
  });

  it('builds owner-scoped album and song refs and uses song coverArt as the fetch fallback', async () => {
    await warmHomeMainstageCovers({
      heroAlbums: [{
        id: 'album-1',
        name: 'Album',
        artist: 'Artist',
        artistId: 'artist-1',
        songCount: 1,
        duration: 100,
        coverArt: 'album-cover',
        serverId: 'srv-owner',
      }],
      recent: [],
      random: [],
      mostPlayed: [],
      recentlyPlayed: [],
      starred: [],
      discoverSongs: [{
        albumId: 'album-2',
        coverArt: 'song-cover',
        serverId: 'srv-owner',
      }],
    });

    const refs = coverCachePeekBatch.mock.calls[0]?.[0] ?? [];
    expect(refs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        cacheEntityId: 'album-1',
        fetchCoverArtId: 'album-cover',
        serverScope: expect.objectContaining({ kind: 'server', serverId: 'srv-owner' }),
      }),
      expect.objectContaining({
        cacheEntityId: 'album-2',
        fetchCoverArtId: 'song-cover',
        serverScope: expect.objectContaining({ kind: 'server', serverId: 'srv-owner' }),
      }),
    ]));
    expect(resolveAlbumCoverRefFromLibrary).not.toHaveBeenCalled();
  });
});

describe('collectAlbumCoverWarmItems', () => {
  it('keys the disk slot by album id when coverArt is a per-file mf-* id', () => {
    const items = collectAlbumCoverWarmItems(
      [{ id: 'al-1', coverArt: 'mf-track_abc', serverId: 'srv' }],
      200,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.ref.cacheEntityId).toBe('al-1');
    expect(items[0]?.ref.fetchCoverArtId).toBe('mf-track_abc');
  });

  it('skips warm when only an mf-* coverArt is present (no album id)', () => {
    const items = collectAlbumCoverWarmItems(
      [{ coverArt: 'mf-track_abc' }],
      200,
    );
    expect(items).toHaveLength(0);
  });
});

describe('warmUniqueAlbumCoversFromLibrary', () => {
  it('resolves equal album ids in separate owner scopes', async () => {
    resolveAlbumCoverRefFromLibrary.mockImplementation(
      async (albumId: string, coverArt: string, serverScope: unknown) => ({
        cacheKind: 'album',
        cacheEntityId: albumId,
        fetchCoverArtId: coverArt,
        serverScope,
      }),
    );

    await warmUniqueAlbumCoversFromLibrary([
      { albumId: 'same', coverArt: 'cover-a', serverId: 'a' },
      { albumId: 'same', coverArt: 'cover-b', serverId: 'b' },
    ], 64);

    expect(resolveAlbumCoverRefFromLibrary).toHaveBeenNthCalledWith(
      1,
      'same',
      'cover-a',
      expect.objectContaining({ kind: 'server', serverId: 'a' }),
    );
    expect(resolveAlbumCoverRefFromLibrary).toHaveBeenNthCalledWith(
      2,
      'same',
      'cover-b',
      expect.objectContaining({ kind: 'server', serverId: 'b' }),
    );
  });
});
