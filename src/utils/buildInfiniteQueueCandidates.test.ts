/**
 * Characterization for `buildInfiniteQueueCandidates` (Instant-Mix-style
 * top-up source for the infinite queue).
 *
 * Originally lived in `playerStore.ts`; extracted in M0 of the frontend
 * refactor (2026-05-12). This test pins the artist-first / random-fallback
 * order, the dedup contract against existingIds, and the autoAdded flag.
 */
import { getSimilarSongs2, getTopSongs } from '../api/subsonicArtists';
import { getRandomSongs } from '../api/subsonicLibrary';
import type { Track } from '../store/playerStoreTypes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/subsonicArtists', () => ({
  getSimilarSongs2: vi.fn(),
  getTopSongs: vi.fn(),
}));

vi.mock('../api/subsonicLibrary', () => ({
  getRandomSongs: vi.fn(),
}));

vi.mock('./mixRatingFilter', () => ({
  getMixMinRatingsConfigFromAuth: vi.fn(),
  enrichSongsForMixRatingFilter: vi.fn(),
  passesMixMinRatings: vi.fn(),
}));

import { buildInfiniteQueueCandidates } from './buildInfiniteQueueCandidates';
import {
  enrichSongsForMixRatingFilter,
  getMixMinRatingsConfigFromAuth,
} from './mixRatingFilter';
import { makeSubsonicSong } from '@/test/helpers/factories';

const seed = (overrides: Partial<Track> = {}): Track => ({
  id: 'seed',
  title: 'Seed',
  artist: 'Artist A',
  album: 'Album A',
  albumId: 'al-A',
  artistId: 'ar-A',
  duration: 180,
  genre: 'Rock',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default mocks — individual tests override as needed. The random-topup loop
  // calls getRandomSongs unconditionally when artist sources don't fill `count`,
  // so a default empty resolution avoids "Cannot read properties of undefined".
  vi.mocked(getSimilarSongs2).mockResolvedValue([]);
  vi.mocked(getTopSongs).mockResolvedValue([]);
  vi.mocked(getRandomSongs).mockResolvedValue([]);
  // Default: filter disabled — the function then short-circuits the enrich path.
  vi.mocked(getMixMinRatingsConfigFromAuth).mockReturnValue({
    enabled: false,
    minSong: 0,
    minAlbum: 0,
    minArtist: 0,
  });
  // Deterministic shuffle: Math.random()=0 collapses Fisher-Yates to a known order.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildInfiniteQueueCandidates', () => {
  it('asks for similar + top in parallel when seedTrack has artistId + artist', async () => {
    vi.mocked(getSimilarSongs2).mockResolvedValue([makeSubsonicSong({ id: 'sim-1' })]);
    vi.mocked(getTopSongs).mockResolvedValue([makeSubsonicSong({ id: 'top-1' })]);

    await buildInfiniteQueueCandidates(seed(), new Set(), 5);

    expect(getSimilarSongs2).toHaveBeenCalledWith('ar-A');
    expect(getTopSongs).toHaveBeenCalledWith('Artist A');
  });

  it('skips similar when artistId is missing', async () => {
    vi.mocked(getSimilarSongs2).mockResolvedValue([]);
    vi.mocked(getTopSongs).mockResolvedValue([makeSubsonicSong({ id: 'top-1' })]);

    await buildInfiniteQueueCandidates(seed({ artistId: undefined }), new Set(), 5);

    expect(getSimilarSongs2).not.toHaveBeenCalled();
    expect(getTopSongs).toHaveBeenCalledWith('Artist A');
  });

  it('skips top when artist name is missing', async () => {
    vi.mocked(getSimilarSongs2).mockResolvedValue([makeSubsonicSong({ id: 'sim-1' })]);
    vi.mocked(getTopSongs).mockResolvedValue([]);

    await buildInfiniteQueueCandidates(seed({ artist: '' }), new Set(), 5);

    expect(getSimilarSongs2).toHaveBeenCalledWith('ar-A');
    expect(getTopSongs).not.toHaveBeenCalled();
  });

  it('skips both when seedTrack is null', async () => {
    vi.mocked(getRandomSongs).mockResolvedValue([]);

    await buildInfiniteQueueCandidates(null, new Set(), 5);

    expect(getSimilarSongs2).not.toHaveBeenCalled();
    expect(getTopSongs).not.toHaveBeenCalled();
  });

  it('marks every returned candidate with autoAdded=true', async () => {
    vi.mocked(getSimilarSongs2).mockResolvedValue([
      makeSubsonicSong({ id: 'sim-1' }),
      makeSubsonicSong({ id: 'sim-2' }),
    ]);
    vi.mocked(getTopSongs).mockResolvedValue([makeSubsonicSong({ id: 'top-1' })]);
    vi.mocked(getRandomSongs).mockResolvedValue([]);

    const out = await buildInfiniteQueueCandidates(seed(), new Set(), 5);

    expect(out.length).toBeGreaterThan(0);
    for (const t of out) expect(t.autoAdded).toBe(true);
  });

  it('excludes the seedTrack id and existingIds from the result', async () => {
    vi.mocked(getSimilarSongs2).mockResolvedValue([
      makeSubsonicSong({ id: 'seed' }), // self → excluded
      makeSubsonicSong({ id: 'already-in-queue' }), // in existingIds → excluded
      makeSubsonicSong({ id: 'fresh-1' }),
    ]);
    vi.mocked(getTopSongs).mockResolvedValue([]);
    vi.mocked(getRandomSongs).mockResolvedValue([]);

    const out = await buildInfiniteQueueCandidates(seed(), new Set(['already-in-queue']), 5);

    const ids = out.map(t => t.id);
    expect(ids).toContain('fresh-1');
    expect(ids).not.toContain('seed');
    expect(ids).not.toContain('already-in-queue');
  });

  it('falls back to getRandomSongs when artist sources are empty', async () => {
    vi.mocked(getSimilarSongs2).mockResolvedValue([]);
    vi.mocked(getTopSongs).mockResolvedValue([]);
    vi.mocked(getRandomSongs).mockResolvedValue([
      makeSubsonicSong({ id: 'rnd-1' }),
      makeSubsonicSong({ id: 'rnd-2' }),
      makeSubsonicSong({ id: 'rnd-3' }),
    ]);

    const out = await buildInfiniteQueueCandidates(seed(), new Set(), 3);

    expect(getRandomSongs).toHaveBeenCalled();
    expect(out.map(t => t.id).sort()).toEqual(['rnd-1', 'rnd-2', 'rnd-3']);
  });

  it('passes the seed track genre to getRandomSongs', async () => {
    vi.mocked(getSimilarSongs2).mockResolvedValue([]);
    vi.mocked(getTopSongs).mockResolvedValue([]);
    vi.mocked(getRandomSongs).mockResolvedValue([makeSubsonicSong({ id: 'rnd-1' })]);

    await buildInfiniteQueueCandidates(seed({ genre: 'Jazz' }), new Set(), 1);

    expect(getRandomSongs).toHaveBeenCalledWith(expect.any(Number), 'Jazz');
  });

  it('stops after up to 8 random batches when supply is exhausted', async () => {
    vi.mocked(getSimilarSongs2).mockResolvedValue([]);
    vi.mocked(getTopSongs).mockResolvedValue([]);
    // Each batch returns one same song that's already counted → no progress.
    vi.mocked(getRandomSongs).mockResolvedValue([makeSubsonicSong({ id: 'dup' })]);

    await buildInfiniteQueueCandidates(seed(), new Set(['dup']), 5);

    // Cap is 8 batches.
    expect(vi.mocked(getRandomSongs).mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('breaks the random loop early when getRandomSongs returns an empty batch', async () => {
    vi.mocked(getSimilarSongs2).mockResolvedValue([]);
    vi.mocked(getTopSongs).mockResolvedValue([]);
    vi.mocked(getRandomSongs).mockResolvedValue([]);

    await buildInfiniteQueueCandidates(seed(), new Set(), 5);

    // First batch is empty → loop breaks immediately, no second call.
    expect(vi.mocked(getRandomSongs).mock.calls.length).toBe(1);
  });

  it('survives a rejected getSimilarSongs2 call (catches and treats as empty)', async () => {
    vi.mocked(getSimilarSongs2).mockRejectedValue(new Error('boom'));
    vi.mocked(getTopSongs).mockResolvedValue([makeSubsonicSong({ id: 'top-1' })]);
    vi.mocked(getRandomSongs).mockResolvedValue([]);

    const out = await buildInfiniteQueueCandidates(seed(), new Set(), 5);

    expect(out.map(t => t.id)).toContain('top-1');
  });

  it('survives a rejected getTopSongs call (catches and treats as empty)', async () => {
    vi.mocked(getSimilarSongs2).mockResolvedValue([makeSubsonicSong({ id: 'sim-1' })]);
    vi.mocked(getTopSongs).mockRejectedValue(new Error('boom'));
    vi.mocked(getRandomSongs).mockResolvedValue([]);

    const out = await buildInfiniteQueueCandidates(seed(), new Set(), 5);

    expect(out.map(t => t.id)).toContain('sim-1');
  });

  it('returns at most `count` items even when sources oversupply', async () => {
    vi.mocked(getSimilarSongs2).mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => makeSubsonicSong({ id: `sim-${i}` })),
    );
    vi.mocked(getTopSongs).mockResolvedValue([]);
    vi.mocked(getRandomSongs).mockResolvedValue([]);

    const out = await buildInfiniteQueueCandidates(seed(), new Set(), 3);

    expect(out).toHaveLength(3);
  });

  it('runs the rating-filter enrichment pipeline when filter is enabled', async () => {
    vi.mocked(getMixMinRatingsConfigFromAuth).mockReturnValue({
      enabled: true,
      minSong: 3,
      minAlbum: 0,
      minArtist: 0,
    });
    vi.mocked(enrichSongsForMixRatingFilter).mockResolvedValue([
      makeSubsonicSong({ id: 'sim-1' }),
    ]);
    vi.mocked(getSimilarSongs2).mockResolvedValue([makeSubsonicSong({ id: 'sim-1' })]);
    vi.mocked(getTopSongs).mockResolvedValue([]);
    vi.mocked(getRandomSongs).mockResolvedValue([]);

    await buildInfiniteQueueCandidates(seed(), new Set(), 5);

    expect(enrichSongsForMixRatingFilter).toHaveBeenCalled();
  });

  it('returns an empty array when nothing usable is found', async () => {
    vi.mocked(getSimilarSongs2).mockResolvedValue([]);
    vi.mocked(getTopSongs).mockResolvedValue([]);
    vi.mocked(getRandomSongs).mockResolvedValue([]);

    const out = await buildInfiniteQueueCandidates(seed(), new Set(), 5);

    expect(out).toEqual([]);
  });
});
