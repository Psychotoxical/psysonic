import { describe, expect, it } from 'vitest';
import {
  applyAlbumServerMetadataPatch,
  diffAlbumServerMetadata,
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

  it('applyAlbumServerMetadataPatch clears unrated stars', () => {
    const patched = applyAlbumServerMetadataPatch(
      { ...base, userRating: 2, starred: 'x' },
      { userRating: 0, starred: undefined },
    );
    expect(patched.userRating).toBeUndefined();
    expect(patched.starred).toBeUndefined();
  });
});
