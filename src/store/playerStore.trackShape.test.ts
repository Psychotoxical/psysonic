/**
 * Pure-helper characterization for `playerStore` mapping + utility functions.
 *
 * Scope: `songToTrack`, `resolveReplayGainDb`, `shuffleArray`. No store
 * mutation — these are exported pure functions used by enqueue paths and the
 * server-queue restore.
 *
 * Pinned as part of Phase F1 / PR 2a (pre-refactor testing plan, 2026-05-11).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveReplayGainDb, shuffleArray, songToTrack, type Track } from './playerStore';
import { makeSubsonicSong } from '@/test/helpers/factories';

describe('songToTrack', () => {
  it('maps required Subsonic fields verbatim', () => {
    const song = makeSubsonicSong({
      id: 's1',
      title: 'Hello',
      artist: 'World',
      album: 'Sample',
      albumId: 'a1',
      duration: 240,
    });
    const t = songToTrack(song);
    expect(t.id).toBe('s1');
    expect(t.title).toBe('Hello');
    expect(t.artist).toBe('World');
    expect(t.album).toBe('Sample');
    expect(t.albumId).toBe('a1');
    expect(t.duration).toBe(240);
  });

  it('copies optional fields when present', () => {
    const song = makeSubsonicSong({
      id: 's2',
      artistId: 'ar-1',
      track: 5,
      year: 2024,
      bitRate: 320,
      suffix: 'flac',
      userRating: 4,
      starred: '2026-05-01T00:00:00Z',
      genre: 'Rock',
      samplingRate: 48000,
      bitDepth: 24,
      size: 9_000_000,
      coverArt: 's2',
    });
    const t = songToTrack(song);
    expect(t.artistId).toBe('ar-1');
    expect(t.track).toBe(5);
    expect(t.year).toBe(2024);
    expect(t.bitRate).toBe(320);
    expect(t.suffix).toBe('flac');
    expect(t.userRating).toBe(4);
    expect(t.starred).toBe('2026-05-01T00:00:00Z');
    expect(t.genre).toBe('Rock');
    expect(t.samplingRate).toBe(48000);
    expect(t.bitDepth).toBe(24);
    expect(t.size).toBe(9_000_000);
    expect(t.coverArt).toBe('s2');
  });

  it('flattens replayGain into replayGainTrackDb / AlbumDb / Peak', () => {
    const song = makeSubsonicSong({
      replayGain: {
        trackGain: -6.5,
        albumGain: -7.1,
        trackPeak: 0.98,
        albumPeak: 0.99,
      },
    });
    const t = songToTrack(song);
    expect(t.replayGainTrackDb).toBe(-6.5);
    expect(t.replayGainAlbumDb).toBe(-7.1);
    expect(t.replayGainPeak).toBe(0.98);
    // albumPeak is intentionally not surfaced — only trackPeak.
    expect((t as Track & { replayGainAlbumPeak?: number }).replayGainAlbumPeak).toBeUndefined();
  });

  it('leaves replayGain fields undefined when the song has no replayGain block', () => {
    const song = makeSubsonicSong({ replayGain: undefined });
    const t = songToTrack(song);
    expect(t.replayGainTrackDb).toBeUndefined();
    expect(t.replayGainAlbumDb).toBeUndefined();
    expect(t.replayGainPeak).toBeUndefined();
  });

  it('does not invent fields that the Subsonic song lacks', () => {
    const song = makeSubsonicSong({});
    const t = songToTrack(song);
    // Internal queue-routing flags are added by enqueue paths, not by mapping.
    expect(t.autoAdded).toBeUndefined();
    expect(t.radioAdded).toBeUndefined();
    expect(t.playNextAdded).toBeUndefined();
  });
});

describe('resolveReplayGainDb', () => {
  const t = (overrides: Partial<Track> = {}): Track => ({
    id: 'x',
    title: 'x',
    artist: 'x',
    album: 'a',
    albumId: 'a-1',
    duration: 100,
    ...overrides,
  });

  it('returns null when ReplayGain is disabled', () => {
    const track = t({ replayGainTrackDb: -6, replayGainAlbumDb: -7 });
    expect(resolveReplayGainDb(track, null, null, false, 'track')).toBeNull();
    expect(resolveReplayGainDb(track, null, null, false, 'album')).toBeNull();
    expect(resolveReplayGainDb(track, null, null, false, 'auto')).toBeNull();
  });

  it('mode=track uses the track gain', () => {
    const track = t({ replayGainTrackDb: -6, replayGainAlbumDb: -7 });
    expect(resolveReplayGainDb(track, null, null, true, 'track')).toBe(-6);
  });

  it('mode=album uses the album gain when present', () => {
    const track = t({ replayGainTrackDb: -6, replayGainAlbumDb: -7 });
    expect(resolveReplayGainDb(track, null, null, true, 'album')).toBe(-7);
  });

  it('mode=album falls back to track gain when album is missing', () => {
    const track = t({ replayGainTrackDb: -6 });
    expect(resolveReplayGainDb(track, null, null, true, 'album')).toBe(-6);
  });

  it('mode=auto picks album gain when the prev neighbour shares the albumId', () => {
    const track = t({ albumId: 'shared', replayGainTrackDb: -6, replayGainAlbumDb: -8 });
    const prev = t({ albumId: 'shared' });
    expect(resolveReplayGainDb(track, prev, null, true, 'auto')).toBe(-8);
  });

  it('mode=auto picks album gain when the next neighbour shares the albumId', () => {
    const track = t({ albumId: 'shared', replayGainTrackDb: -6, replayGainAlbumDb: -8 });
    const next = t({ albumId: 'shared' });
    expect(resolveReplayGainDb(track, null, next, true, 'auto')).toBe(-8);
  });

  it('mode=auto picks track gain when neither neighbour shares the albumId', () => {
    const track = t({ albumId: 'a-1', replayGainTrackDb: -6, replayGainAlbumDb: -8 });
    const other = t({ albumId: 'a-2' });
    expect(resolveReplayGainDb(track, other, other, true, 'auto')).toBe(-6);
  });

  it('mode=auto treats a missing albumId as no-album-match (returns track gain)', () => {
    const track = t({ albumId: '', replayGainTrackDb: -6, replayGainAlbumDb: -8 } as Track);
    const prev = t({ albumId: '' } as Track);
    expect(resolveReplayGainDb(track, prev, null, true, 'auto')).toBe(-6);
  });

  it('returns null when both gains are missing', () => {
    const track = t({});
    expect(resolveReplayGainDb(track, null, null, true, 'track')).toBeNull();
    expect(resolveReplayGainDb(track, null, null, true, 'album')).toBeNull();
    expect(resolveReplayGainDb(track, null, null, true, 'auto')).toBeNull();
  });
});

describe('shuffleArray', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not mutate the input array', () => {
    const input = [1, 2, 3, 4, 5];
    const snapshot = [...input];
    shuffleArray(input);
    expect(input).toEqual(snapshot);
  });

  it('preserves the multiset of elements (same length, same members)', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    const out = shuffleArray(input);
    expect(out).toHaveLength(input.length);
    expect([...out].sort()).toEqual([...input].sort());
  });

  it('returns a copy (not the same reference)', () => {
    const input = [1, 2, 3];
    expect(shuffleArray(input)).not.toBe(input);
  });

  it('returns an empty array when called with an empty array', () => {
    expect(shuffleArray([])).toEqual([]);
  });

  it('returns the single-element input unchanged', () => {
    expect(shuffleArray(['only'])).toEqual(['only']);
  });

  it('produces a deterministic order under a mocked RNG (Math.random=0 picks j=0 each iteration)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // With Math.random()=0, j=floor(0 * (i+1))=0 for every i. The Fisher-Yates
    // step swaps arr[i] with arr[0]. Walk it through for [1,2,3,4]:
    //   i=3: swap(3,0) → [4,2,3,1]
    //   i=2: swap(2,0) → [3,2,4,1]
    //   i=1: swap(1,0) → [2,3,4,1]
    expect(shuffleArray([1, 2, 3, 4])).toEqual([2, 3, 4, 1]);
  });
});
