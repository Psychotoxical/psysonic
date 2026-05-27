import { describe, expect, it } from 'vitest';
import {
  albumCoverRef,
  albumCoverRefForPlayback,
  albumCoverRefForSong,
  albumHasDistinctDiscCovers,
  rememberAlbumDistinctDiscCovers,
  resolveAlbumCoverCacheEntityId,
  resolveDistinctDiscCoversForAlbum,
} from './ref';

describe('resolveAlbumCoverCacheEntityId', () => {
  it('uses album id when fetch matches or is empty', () => {
    expect(resolveAlbumCoverCacheEntityId('al-1', 'al-1')).toBe('al-1');
    expect(resolveAlbumCoverCacheEntityId('al-1', null)).toBe('al-1');
    expect(resolveAlbumCoverCacheEntityId('al-1', '')).toBe('al-1');
  });

  it('ignores mf-* fetch unless distinctDiscCovers', () => {
    expect(resolveAlbumCoverCacheEntityId('al-box', 'mf-disc2_abc')).toBe('al-box');
    expect(resolveAlbumCoverCacheEntityId('al-box', 'mf-disc2_abc', true)).toBe('mf-disc2_abc');
  });
});

describe('albumHasDistinctDiscCovers', () => {
  it('false for single disc', () => {
    expect(
      albumHasDistinctDiscCovers([
        { id: 't1', albumId: 'al-1', coverArt: 'mf-a', discNumber: 1 },
      ]),
    ).toBe(false);
  });

  it('false when two discs share the same art id', () => {
    expect(
      albumHasDistinctDiscCovers([
        { id: 't1', albumId: 'al-1', coverArt: 'mf-same', discNumber: 1 },
        { id: 't2', albumId: 'al-1', coverArt: 'mf-same', discNumber: 2 },
      ]),
    ).toBe(false);
  });

  it('true when two discs have different art ids', () => {
    expect(
      albumHasDistinctDiscCovers([
        { id: 't1', albumId: 'al-1', coverArt: 'mf-a', discNumber: 1 },
        { id: 't2', albumId: 'al-1', coverArt: 'mf-b', discNumber: 2 },
      ]),
    ).toBe(true);
  });
});

describe('albumCoverRef', () => {
  it('keys by album id for mf fetch by default', () => {
    const ref = albumCoverRef('al-box', 'mf-disc1_xyz');
    expect(ref.cacheEntityId).toBe('al-box');
    expect(ref.fetchCoverArtId).toBe('mf-disc1_xyz');
  });

  it('keys by fetch id when distinctDiscCovers', () => {
    const ref = albumCoverRef('al-box', 'mf-disc1_xyz', { distinctDiscCovers: true });
    expect(ref.cacheEntityId).toBe('mf-disc1_xyz');
  });
});

describe('resolveDistinctDiscCoversForAlbum', () => {
  it('detects mf-* fetch id before album page visit', () => {
    expect(resolveDistinctDiscCoversForAlbum('al-box', 'mf-d2')).toBe(true);
    expect(resolveDistinctDiscCoversForAlbum('al-box', 'al-box')).toBe(false);
  });

  it('respects remembered false for same art on all discs', () => {
    rememberAlbumDistinctDiscCovers('al-same', [
      { id: 't1', albumId: 'al-same', coverArt: 'mf-x', discNumber: 1 },
      { id: 't2', albumId: 'al-same', coverArt: 'mf-x', discNumber: 2 },
    ]);
    expect(resolveDistinctDiscCoversForAlbum('al-same', 'mf-x')).toBe(false);
  });
});

describe('albumCoverRefForSong', () => {
  it('keys per-disc without library resolve', () => {
    const ref = albumCoverRefForSong({
      id: 't2',
      albumId: 'al-box',
      coverArt: 'mf-d2',
      discNumber: 2,
    });
    expect(ref?.cacheEntityId).toBe('mf-d2');
  });
});

describe('albumCoverRefForPlayback', () => {
  it('keys per-disc from mf coverArt before album page visit', () => {
    const ref = albumCoverRefForPlayback(
      { albumId: 'al-box', coverArt: 'mf-disc2', id: 't2', discNumber: 2 },
      { kind: 'active' },
    );
    expect(ref?.cacheEntityId).toBe('mf-disc2');
    expect(ref?.fetchCoverArtId).toBe('mf-disc2');
  });

  it('uses remembered album flag', () => {
    rememberAlbumDistinctDiscCovers('al-1', [
      { id: 't1', albumId: 'al-1', coverArt: 'mf-a', discNumber: 1 },
      { id: 't2', albumId: 'al-1', coverArt: 'mf-b', discNumber: 2 },
    ]);
    const ref = albumCoverRefForPlayback(
      { albumId: 'al-1', coverArt: 'mf-b', id: 't2', discNumber: 2 },
      { kind: 'active' },
    );
    expect(ref?.cacheEntityId).toBe('mf-b');
  });
});
