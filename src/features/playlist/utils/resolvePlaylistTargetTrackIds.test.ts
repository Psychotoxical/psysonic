import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePlaylistTargetTrackIds } from './resolvePlaylistTargetTrackIds';
import { libraryResolveEntitySources } from '@/lib/api/library';
import type { Track } from '@/lib/media/trackTypes';

vi.mock('@/lib/api/library', () => ({ libraryResolveEntitySources: vi.fn() }));

const track = (id: string, serverId: string): Track => ({
  id, serverId, title: id, artist: '', album: '', albumId: '', duration: 1,
});

describe('resolvePlaylistTargetTrackIds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps target-owned ids and resolves a matching copy for foreign merged tracks', async () => {
    vi.mocked(libraryResolveEntitySources).mockResolvedValue([
      { serverId: 'target', id: 'copy-2', libraryId: '', priority: 1, durationSec: null, suffix: null, bitRate: null, sizeBytes: null, starredAt: null, userRating: null },
    ]);
    await expect(resolvePlaylistTargetTrackIds('target', [
      track('same-id', 'target'),
      track('foreign-id', 'other'),
    ], [{ serverId: 'target', libraryId: null }, { serverId: 'other', libraryId: null }]))
      .resolves.toEqual(['same-id', 'copy-2']);
  });
});
