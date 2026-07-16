import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryAlbumDto, LibraryTrackDto } from '@/lib/api/library/dto';

const libraryScopeAlbumDetailMock = vi.fn();

vi.mock('@/lib/api/library/scopeReads', () => ({
  libraryScopeAlbumDetail: (...args: unknown[]) => libraryScopeAlbumDetailMock(...args),
}));

import { tryLoadAlbumDetailMultiScope } from './loadAlbumDetailMultiScope';

function albumDto(overrides: Partial<LibraryAlbumDto> = {}): LibraryAlbumDto {
  return {
    serverId: 'srv-1',
    id: 'alb-1',
    name: 'Merged Album',
    artist: 'Artist',
    artistId: 'art-1',
    songCount: 2,
    durationSec: 300,
    syncedAt: 0,
    rawJson: {},
    ...overrides,
  };
}

function trackDto(overrides: Partial<LibraryTrackDto> = {}): LibraryTrackDto {
  return {
    serverId: 'srv-1',
    id: 'trk-1',
    title: 'Track One',
    album: 'Merged Album',
    albumId: 'alb-1',
    durationSec: 150,
    syncedAt: 0,
    rawJson: {},
    ...overrides,
  };
}

describe('tryLoadAlbumDetailMultiScope', () => {
  beforeEach(() => {
    libraryScopeAlbumDetailMock.mockReset();
  });

  it('maps scope album detail into ResolvedAlbum', async () => {
    libraryScopeAlbumDetailMock.mockResolvedValue({
      album: albumDto(),
      tracks: [trackDto(), trackDto({ id: 'trk-2', title: 'Track Two', trackNumber: 2 })],
    });

    const result = await tryLoadAlbumDetailMultiScope('srv-1', 'alb-1', [
      { serverId: 'srv-1-idx', libraryId: 'lib-a' },
      { serverId: 'srv-1-idx', libraryId: 'lib-b' },
    ]);

    expect(libraryScopeAlbumDetailMock).toHaveBeenCalledWith('srv-1', {
      scopes: [
        { serverId: 'srv-1-idx', libraryId: 'lib-a' },
        { serverId: 'srv-1-idx', libraryId: 'lib-b' },
      ],
      albumId: 'alb-1',
      serverId: 'srv-1',
    });
    expect(result?.album).toMatchObject({ id: 'alb-1', name: 'Merged Album', artistId: 'art-1' });
    expect(result?.songs).toHaveLength(2);
    expect(result?.songs[0]).toMatchObject({ id: 'trk-1', title: 'Track One' });
  });

  it('returns null when the merged album anchor is missing', async () => {
    libraryScopeAlbumDetailMock.mockResolvedValue({
      album: albumDto({ id: '' }),
      tracks: [],
    });

    await expect(tryLoadAlbumDetailMultiScope('srv-1', 'alb-1', [])).resolves.toBeNull();
  });

  it('returns null when the scope command throws', async () => {
    libraryScopeAlbumDetailMock.mockRejectedValue(new Error('ipc fail'));

    await expect(tryLoadAlbumDetailMultiScope('srv-1', 'alb-1', [])).resolves.toBeNull();
  });
});
