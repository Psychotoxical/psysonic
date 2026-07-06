import { describe, expect, it, beforeEach } from 'vitest';
import { onInvoke, invokeMock } from '@/test/mocks/tauri';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import {
  applyAlbumServerMetadataPatch,
  diffAlbumServerMetadata,
  patchAlbumStarToIndexFromReconcile,
} from './albumServerMetadataReconcile';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';

const base: SubsonicAlbum = {
  id: 'al1',
  name: 'Album',
  artist: 'Artist',
  artistId: 'ar1',
  songCount: 1,
  duration: 100,
};

describe('albumServerMetadataReconcile', () => {
  it('returns null when metadata matches', () => {
    const local = { ...base, userRating: 4, starred: '2024-01-01T00:00:00Z' };
    const server = { ...base, userRating: 4, starred: '2024-01-01T00:00:00Z' };
    expect(diffAlbumServerMetadata(local, server)).toBeNull();
  });

  it('detects rating and starred drift', () => {
    const local = { ...base, userRating: 2 };
    const server = { ...base, userRating: 5, starred: '2024-01-01T00:00:00Z' };
    expect(diffAlbumServerMetadata(local, server)).toEqual({
      userRating: 5,
      starred: '2024-01-01T00:00:00Z',
    });
  });

  it('rating-only drift omits starred from patch', () => {
    const local = { ...base, userRating: 2, starred: '2024-01-01T00:00:00Z' };
    const server = { ...base, userRating: 5 };
    expect(diffAlbumServerMetadata(local, server)).toEqual({ userRating: 5 });
  });

  it('applyAlbumServerMetadataPatch clears unrated stars', () => {
    const patched = applyAlbumServerMetadataPatch(
      { ...base, userRating: 2, starred: 'x' },
      { userRating: 0, starred: undefined },
    );
    expect(patched.userRating).toBeUndefined();
    expect(patched.starred).toBeUndefined();
  });
});

describe('patchAlbumStarToIndexFromReconcile', () => {
  beforeEach(() => {
    useLibraryIndexStore.setState({ masterEnabled: true });
    onInvoke('library_patch_album', () => undefined);
  });

  it('mirrors reconciled star into the index', async () => {
    patchAlbumStarToIndexFromReconcile('s1', 'al1', {
      userRating: 0,
      starred: '2024-01-01T00:00:00Z',
    });
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith('library_patch_album', {
      serverId: 's1',
      albumId: 'al1',
      patch: { starredAt: Date.parse('2024-01-01T00:00:00Z') },
    });
  });

  it('skips index patch for rating-only reconcile', async () => {
    patchAlbumStarToIndexFromReconcile('s1', 'al1', { userRating: 4 });
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
