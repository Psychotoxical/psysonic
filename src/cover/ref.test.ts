import { describe, expect, it } from 'vitest';
import {
  albumCoverRef,
  albumCoverRefForPlayback,
  albumCoverRefForSong,
  albumHasDistinctDiscCovers,
  forgetAlbumDistinctDiscCovers,
  navidromeDiscCoverRef,
  rememberAlbumDiscCount,
  rememberAlbumDistinctDiscCovers,
  radioCoverRef,
  resolveAlbumCoverCacheEntityId,
  resolveAlbumDiscCount,
  resolveDistinctDiscCoversForAlbum,
} from './ref';

describe('radioCoverRef', () => {
  it('keeps duplicate radio ids in the owning server cover bucket', () => {
    const ref = radioCoverRef({ id: 'shared', serverId: 'srv-b' });
    expect(ref.cacheEntityId).toBe('ra-shared');
    expect(ref.fetchCoverArtId).toBe('ra-shared');
    expect(ref.serverScope).toMatchObject({ kind: 'server', serverId: 'srv-b' });
  });
});

describe('album disc count seed', () => {
  it('records the distinct disc count from a known tracklist', () => {
    rememberAlbumDistinctDiscCovers('al-two-disc', [
      { id: 't1', albumId: 'al-two-disc', coverArt: 'mf-a', discNumber: 1 },
      { id: 't2', albumId: 'al-two-disc', coverArt: 'mf-b', discNumber: 1 },
      { id: 't3', albumId: 'al-two-disc', coverArt: 'mf-c', discNumber: 2 },
    ], 'srv-x');
    expect(resolveAlbumDiscCount('al-two-disc', 'srv-x')).toBe(2);
  });

  it('treats a missing disc number as disc 1', () => {
    rememberAlbumDistinctDiscCovers('al-nodisc', [
      { id: 't1', albumId: 'al-nodisc', coverArt: 'mf-a', discNumber: undefined },
      { id: 't2', albumId: 'al-nodisc', coverArt: 'mf-b', discNumber: undefined },
    ], 'srv-x');
    expect(resolveAlbumDiscCount('al-nodisc', 'srv-x')).toBe(1);
  });

  it('remembers an explicit count and forgets it with the distinct verdict', () => {
    rememberAlbumDiscCount('al-explicit', 3, 'srv-x');
    expect(resolveAlbumDiscCount('al-explicit', 'srv-x')).toBe(3);
    forgetAlbumDistinctDiscCovers('al-explicit', 'srv-x');
    expect(resolveAlbumDiscCount('al-explicit', 'srv-x')).toBeUndefined();
  });

  it('is undefined for an unseeded album', () => {
    expect(resolveAlbumDiscCount('al-never-seen', 'srv-x')).toBeUndefined();
  });
});

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
  it('defaults to album-scoped for an unknown album', () => {
    // A single mf-<id> cover is per-song art, not per-disc — must not be guessed
    // as distinct (would surface per-track covers in the player/queue).
    expect(resolveDistinctDiscCoversForAlbum('al-unknown')).toBe(false);
  });

  it('respects remembered true for differing disc art', () => {
    rememberAlbumDistinctDiscCovers('al-distinct-box', [
      { id: 't1', albumId: 'al-distinct-box', coverArt: 'mf-a', discNumber: 1 },
      { id: 't2', albumId: 'al-distinct-box', coverArt: 'mf-b', discNumber: 2 },
    ]);
    expect(resolveDistinctDiscCoversForAlbum('al-distinct-box')).toBe(true);
  });

  it('respects remembered false for same art on all discs', () => {
    rememberAlbumDistinctDiscCovers('al-same', [
      { id: 't1', albumId: 'al-same', coverArt: 'mf-x', discNumber: 1 },
      { id: 't2', albumId: 'al-same', coverArt: 'mf-x', discNumber: 2 },
    ]);
    expect(resolveDistinctDiscCoversForAlbum('al-same')).toBe(false);
  });

  it('isolates equal album ids by owner server', () => {
    rememberAlbumDistinctDiscCovers('shared', [
      { id: 'a1', albumId: 'shared', coverArt: 'mf-a', discNumber: 1 },
      { id: 'a2', albumId: 'shared', coverArt: 'mf-b', discNumber: 2 },
    ], 'srv-a');
    rememberAlbumDistinctDiscCovers('shared', [
      { id: 'b1', albumId: 'shared', coverArt: 'mf-same', discNumber: 1 },
      { id: 'b2', albumId: 'shared', coverArt: 'mf-same', discNumber: 2 },
    ], 'srv-b');

    expect(resolveDistinctDiscCoversForAlbum('shared', 'srv-a')).toBe(true);
    expect(resolveDistinctDiscCoversForAlbum('shared', 'srv-b')).toBe(false);
  });
});

describe('navidromeDiscCoverRef', () => {
  it('builds a per-disc dc- fetch id and cache slot from albumId + discNumber', () => {
    const ref = navidromeDiscCoverRef('0Za0MjhoHc6moGy2RyHga5', 2);
    expect(ref?.cacheKind).toBe('album');
    expect(ref?.cacheEntityId).toBe('dc-0Za0MjhoHc6moGy2RyHga5:2');
    expect(ref?.fetchCoverArtId).toBe('dc-0Za0MjhoHc6moGy2RyHga5:2');
  });

  it('gives each disc its own slot (no collision)', () => {
    const d1 = navidromeDiscCoverRef('al-btw', 1);
    const d2 = navidromeDiscCoverRef('al-btw', 2);
    expect(d1?.cacheEntityId).not.toBe(d2?.cacheEntityId);
  });

  it('returns undefined without a usable album id / disc number', () => {
    expect(navidromeDiscCoverRef('', 1)).toBeUndefined();
    expect(navidromeDiscCoverRef('al-1', Number.NaN)).toBeUndefined();
  });
});

describe('albumCoverRefForSong', () => {
  it('keys by album id for an unknown album', () => {
    const ref = albumCoverRefForSong({
      id: 't2',
      albumId: 'al-box',
      coverArt: 'mf-d2',
      discNumber: 2,
    });
    expect(ref?.cacheEntityId).toBe('al-box');
  });

  it('keys per-disc when told explicitly', () => {
    const ref = albumCoverRefForSong(
      { id: 't2', albumId: 'al-box', coverArt: 'mf-d2', discNumber: 2 },
      true,
    );
    expect(ref?.cacheEntityId).toBe('mf-d2');
  });
});

describe('albumCoverRefForPlayback', () => {
  it('keys by album id from mf coverArt before album page visit', () => {
    // Bug fix: a playlist track whose album was never opened must resolve to the
    // album cache slot (album cover), not a per-track slot (per-track cover).
    const ref = albumCoverRefForPlayback(
      { albumId: 'al-pl', coverArt: 'mf-disc2', id: 't2', discNumber: 2 },
      { kind: 'active' },
    );
    expect(ref?.cacheEntityId).toBe('al-pl');
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

  it('uses the playing track owner for duplicate album ids', () => {
    rememberAlbumDistinctDiscCovers('shared', [
      { id: 'a1', albumId: 'shared', coverArt: 'mf-a', discNumber: 1 },
      { id: 'a2', albumId: 'shared', coverArt: 'mf-b', discNumber: 2 },
    ], 'srv-a');

    expect(albumCoverRefForPlayback({
      albumId: 'shared',
      coverArt: 'mf-b',
      id: 'a2',
      discNumber: 2,
      serverId: 'srv-a',
    }, { kind: 'active' })?.cacheEntityId).toBe('mf-b');
    expect(albumCoverRefForPlayback({
      albumId: 'shared',
      coverArt: 'mf-b',
      id: 'b2',
      discNumber: 2,
      serverId: 'srv-b',
    }, { kind: 'active' })?.cacheEntityId).toBe('shared');
  });
});
