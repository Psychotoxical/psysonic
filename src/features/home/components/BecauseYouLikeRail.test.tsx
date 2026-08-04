import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

const { artistInfoMock, artistMock, readCacheMock, writeCacheMock, primeMock } = vi.hoisted(() => ({
  artistInfoMock: vi.fn(),
  artistMock: vi.fn(),
  readCacheMock: vi.fn(),
  writeCacheMock: vi.fn(),
  primeMock: vi.fn(),
}));

vi.mock('@/lib/api/subsonicArtists', () => ({
  getArtistInfoForServer: artistInfoMock,
  getArtistForServer: artistMock,
}));
vi.mock('@/features/home/store/becauseYouLikeCache', () => ({
  readBecauseYouLikeCache: readCacheMock,
  writeBecauseYouLikeCache: writeCacheMock,
}));
vi.mock('@/cover/warmDiskPeek', () => ({ primeAlbumCoversForDisplay: primeMock }));
vi.mock('@/cover/useLibraryCoverPrefetch', () => ({ useLibraryCoverPrefetch: vi.fn() }));
vi.mock('@/cover/useLibraryCoverRef', () => ({ useAlbumCoverRef: () => null }));
vi.mock('@/cover/useCoverArt', () => ({
  useCoverArt: () => ({ src: '', onImgError: vi.fn() }),
}));
vi.mock('@/lib/util/shuffleArray', () => ({ shuffleArray: <T,>(items: T[]) => items }));
vi.mock('@/features/album', () => ({
  AlbumRow: ({ albums }: { albums: SubsonicAlbum[] }) => <div data-testid="albums">{albums.length}</div>,
  albumArtistDisplayName: (item: SubsonicAlbum) => item.artist,
  useNavigateToAlbum: () => vi.fn(),
}));

import BecauseYouLikeRail, { buildAnchorPool } from '@/features/home/components/BecauseYouLikeRail';

function album(serverId: string | undefined, artistId: string, name: string): SubsonicAlbum {
  return {
    id: `${serverId ?? 'missing'}-${artistId}`,
    name: `${name} Album`,
    artist: name,
    artistId,
    songCount: 1,
    duration: 1,
    serverId,
  };
}

describe('buildAnchorPool', () => {
  it('keeps same-id artists from different owners and skips ownerless seeds', () => {
    const pool = buildAnchorPool([
      [album('srv-a', 'artist-1', 'Artist A'), album(undefined, 'artist-2', 'Ownerless')],
      [album('srv-b', 'artist-1', 'Artist B'), album('srv-a', 'artist-1', 'Duplicate')],
    ], 20);

    expect(pool).toEqual([
      { id: 'artist-1', name: 'Artist A', serverId: 'srv-a' },
      { id: 'artist-1', name: 'Artist B', serverId: 'srv-b' },
    ]);
  });
});

describe('BecauseYouLikeRail diagnostics', () => {
  beforeEach(() => {
    artistInfoMock.mockReset();
    artistMock.mockReset();
    readCacheMock.mockReset();
    writeCacheMock.mockReset();
    primeMock.mockReset();
    readCacheMock.mockReturnValue(null);
    primeMock.mockResolvedValue(undefined);
  });

  it('reports cached content immediately and keeps background reserve completion silent', async () => {
    const cachedAlbum = album('srv-a', 'cached-artist', 'Cached');
    readCacheMock.mockReturnValue({
      scopeKey: 'scope',
      scopeVersion: 1,
      anchor: { id: 'cached-artist', name: 'Cached', serverId: 'srv-a' },
      recs: [cachedAlbum],
    });
    let finishReserve!: (value: { similarArtist: never[] }) => void;
    artistInfoMock.mockReturnValue(new Promise(resolve => { finishReserve = resolve; }));
    const onDiagnosticResult = vi.fn();

    renderWithProviders(
      <BecauseYouLikeRail
        mostPlayed={[album('srv-a', 'seed', 'Seed')]}
        scopeKey="scope"
        scopeVersion={1}
        scopes={[{ serverId: 'srv-a', libraryId: 'lib-a' }]}
        onDiagnosticResult={onDiagnosticResult}
      />,
    );

    await waitFor(() => expect(onDiagnosticResult).toHaveBeenCalledTimes(2));
    expect(onDiagnosticResult.mock.calls[0][0]).toMatchObject({
      status: 'loading',
      detail: 'generation 1: pool 1',
    });
    expect(onDiagnosticResult.mock.calls[1][0]).toMatchObject({
      status: 'ready',
      itemCount: 1,
      detail: 'generation 1: cache',
    });
    expect(onDiagnosticResult.mock.calls[1][0].durationMs).toBeTypeOf('number');

    finishReserve({ similarArtist: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(onDiagnosticResult).toHaveBeenCalledTimes(2);
  });

  it('reports network generation errors with elapsed time', async () => {
    artistInfoMock.mockRejectedValue(new Error('offline'));
    const onDiagnosticResult = vi.fn();

    renderWithProviders(
      <BecauseYouLikeRail
        mostPlayed={[album('srv-a', 'seed', 'Seed')]}
        scopeKey="scope"
        scopeVersion={2}
        scopes={[{ serverId: 'srv-a', libraryId: 'lib-a' }]}
        onDiagnosticResult={onDiagnosticResult}
      />,
    );

    await waitFor(() => expect(onDiagnosticResult).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'error',
      itemCount: 0,
      detail: 'generation 1: network',
      durationMs: expect.any(Number),
    })));
  });

  it('requests recommendation albums from the anchor server browse scope', async () => {
    artistInfoMock.mockResolvedValue({
      similarArtist: [{ id: 'similar', name: 'Similar', serverId: 'srv-a' }],
    });
    artistMock.mockResolvedValue({
      artist: { id: 'similar', name: 'Similar', serverId: 'srv-a' },
      albums: [album('srv-a', 'similar', 'Similar')],
    });

    renderWithProviders(
      <BecauseYouLikeRail
        mostPlayed={[album('srv-a', 'seed', 'Seed')]}
        scopeKey="scope-scoped"
        scopeVersion={3}
        scopes={[{ serverId: 'srv-a', libraryId: 'lib-a' }]}
      />,
    );

    await waitFor(() => expect(artistMock).toHaveBeenCalledWith(
      'srv-a',
      'similar',
      { libraryIds: ['lib-a'] },
    ));
  });
});
