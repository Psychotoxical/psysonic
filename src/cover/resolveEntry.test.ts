import { describe, expect, it } from 'vitest';
import {
  albumHasDistinctDiscCovers,
  isFetchOnlyCoverId,
  normalizeAlbumLibraryEntry,
  resolveAlbumCoverEntry,
  resolveArtistCoverEntry,
  resolveSongFetchCoverArtId,
  resolveTrackCoverEntry,
} from './resolveEntry';
import { albumCoverRef } from './ref';

describe('resolveAlbumCoverEntry', () => {
  it('uses bare Navidrome album id on disk', () => {
    const e = resolveAlbumCoverEntry('0DurV2S7arIOBQVEknOPWX', 'al-0Dur_abc');
    expect(e?.cacheEntityId).toBe('0DurV2S7arIOBQVEknOPWX');
    expect(e?.fetchCoverArtId).toBe('al-0Dur_abc');
  });

  it('keeps mf fetch on album bucket unless distinctDiscCovers', () => {
    expect(resolveAlbumCoverEntry('al-box', 'mf-d2')?.cacheEntityId).toBe('al-box');
    expect(resolveAlbumCoverEntry('al-box', 'mf-d2')?.fetchCoverArtId).toBe('mf-d2');
    expect(resolveAlbumCoverEntry('al-box', 'mf-d2', true)?.cacheEntityId).toBe('mf-d2');
    expect(resolveAlbumCoverEntry('al-box', 'mf-d2', true)?.fetchCoverArtId).toBe('mf-d2');
  });

  it('uses Navidrome al-<id>_0 fetch for bare album ids', () => {
    expect(resolveAlbumCoverEntry('2lsdR1ogDKiFcAD6Pcvk4f', null)?.fetchCoverArtId).toBe(
      'al-2lsdR1ogDKiFcAD6Pcvk4f_0',
    );
  });

  it('keeps pl-* playlist cover ids for getCoverArt (no al- prefix)', () => {
    const e = resolveAlbumCoverEntry('pl-abc123', 'pl-abc123');
    expect(e?.cacheEntityId).toBe('pl-abc123');
    expect(e?.fetchCoverArtId).toBe('pl-abc123');
  });

  it('keeps Navidrome pl-{uuid}_0 playlist coverArt from Subsonic API', () => {
    const id = 'pl-18690de0-151b-4d86-81cb-f418a907315a_0';
    const e = resolveAlbumCoverEntry(id, id);
    expect(e?.fetchCoverArtId).toBe(id);
  });

  it('keeps ra-* internet radio cover ids (no al- prefix)', () => {
    const e = resolveAlbumCoverEntry('ra-rd-1_0', 'ra-rd-1_0');
    expect(e?.fetchCoverArtId).toBe('ra-rd-1_0');
  });
});

describe('isFetchOnlyCoverId', () => {
  it('matches Navidrome getCoverArt-only prefixes', () => {
    expect(isFetchOnlyCoverId('pl-abc')).toBe(true);
    expect(isFetchOnlyCoverId('ra-rd-1_0')).toBe(true);
    expect(isFetchOnlyCoverId('mf-track')).toBe(true);
    expect(isFetchOnlyCoverId('dc-album:2')).toBe(true);
  });

  it('does not match bare album hashes', () => {
    expect(isFetchOnlyCoverId('2lsdR1ogDKiFcAD6Pcvk4f')).toBe(false);
    expect(isFetchOnlyCoverId('al-2lsd_0')).toBe(false);
  });
});

describe('albumCoverRef fetch-only ids', () => {
  it('preserves pl-* for playlist hero/card covers', () => {
    const id = 'pl-18690de0-151b-4d86-81cb-f418a907315a_0';
    const ref = albumCoverRef(id, id);
    expect(ref.fetchCoverArtId).toBe(id);
  });
});

describe('resolveArtistCoverEntry', () => {
  it('keys by artist id', () => {
    const e = resolveArtistCoverEntry('03b645ef2100dfc4', 'ar-03b645ef');
    expect(e?.cacheKind).toBe('artist');
    expect(e?.cacheEntityId).toBe('03b645ef2100dfc4');
    expect(e?.fetchCoverArtId).toBe('ar-03b645ef');
  });
});

describe('resolveTrackCoverEntry', () => {
  it('defaults to album bucket', () => {
    const e = resolveTrackCoverEntry({
      id: 't1',
      albumId: 'al-1',
      coverArt: 'mf-a',
    });
    expect(e?.cacheEntityId).toBe('al-1');
    expect(e?.fetchCoverArtId).toBe('mf-a');
  });
});

describe('resolveSongFetchCoverArtId', () => {
  it('falls back to albumId when coverArt echoes track id', () => {
    expect(
      resolveSongFetchCoverArtId({ id: 'tr-1', coverArt: 'tr-1', albumId: 'al-42' }),
    ).toBe('al-42');
  });
});

describe('albumHasDistinctDiscCovers', () => {
  it('true when discs differ', () => {
    expect(
      albumHasDistinctDiscCovers([
        { id: 't1', albumId: 'al-1', coverArt: 'mf-a', discNumber: 1 },
        { id: 't2', albumId: 'al-1', coverArt: 'mf-b', discNumber: 2 },
      ]),
    ).toBe(true);
  });

  it('false for per-song ids within a single disc (Navidrome)', () => {
    expect(
      albumHasDistinctDiscCovers([
        { id: 't1', albumId: 'al-1', coverArt: 'mf-1', discNumber: 1 },
        { id: 't2', albumId: 'al-1', coverArt: 'mf-2', discNumber: 1 },
        { id: 't3', albumId: 'al-1', coverArt: 'mf-3', discNumber: 1 },
      ]),
    ).toBe(false);
  });

  it('false for per-song ids across discs (no shared disc cover)', () => {
    expect(
      albumHasDistinctDiscCovers([
        { id: 't1', albumId: 'al-1', coverArt: 'mf-1', discNumber: 1 },
        { id: 't2', albumId: 'al-1', coverArt: 'mf-2', discNumber: 1 },
        { id: 't3', albumId: 'al-1', coverArt: 'mf-3', discNumber: 2 },
        { id: 't4', albumId: 'al-1', coverArt: 'mf-4', discNumber: 2 },
      ]),
    ).toBe(false);
  });
});

describe('normalizeAlbumLibraryEntry', () => {
  it('keeps consensus mf-* fetch on the album bucket', () => {
    const e = normalizeAlbumLibraryEntry('al-1', {
      cacheKind: 'album',
      cacheEntityId: 'al-1',
      fetchCoverArtId: 'mf-track',
    });
    expect(e.fetchCoverArtId).toBe('mf-track');
  });

  it('keeps per-disc mf-* when cache entity is the disc bucket', () => {
    const e = normalizeAlbumLibraryEntry('al-box', {
      cacheKind: 'album',
      cacheEntityId: 'mf-d2',
      fetchCoverArtId: 'mf-d2',
    });
    expect(e.cacheEntityId).toBe('mf-d2');
    expect(e.fetchCoverArtId).toBe('mf-d2');
  });
});
