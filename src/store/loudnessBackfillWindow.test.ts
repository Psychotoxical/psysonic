/**
 * Pure functions over a queue slice: the "is this id inside the prefetch
 * window?" check and the "give me the window's id list" collector. Window
 * = current track + next `LOUDNESS_BACKFILL_WINDOW_AHEAD` entries, with
 * duplicates collapsed.
 */
import { describe, expect, it } from 'vitest';
import type { Track } from './playerStore';
import {
  LOUDNESS_BACKFILL_WINDOW_AHEAD,
  collectLoudnessBackfillWindowTrackIds,
  isTrackInsideLoudnessBackfillWindow,
} from './loudnessBackfillWindow';

function track(id: string): Track {
  return { id, title: id, artist: 'A', album: 'X', albumId: 'X', duration: 100 };
}

const big = Array.from({ length: 12 }, (_, i) => track(`t${i}`));

describe('LOUDNESS_BACKFILL_WINDOW_AHEAD', () => {
  it('is the value the runtime expects', () => {
    expect(LOUDNESS_BACKFILL_WINDOW_AHEAD).toBe(5);
  });
});

describe('isTrackInsideLoudnessBackfillWindow', () => {
  it('matches the current track unconditionally', () => {
    expect(isTrackInsideLoudnessBackfillWindow('t0', big, 0, big[0])).toBe(true);
  });

  it('matches an id inside the ahead window', () => {
    // queueIndex 0, AHEAD 5 → indices 1..5 are inside, t3 must hit.
    expect(isTrackInsideLoudnessBackfillWindow('t3', big, 0, big[0])).toBe(true);
  });

  it('returns false for an id beyond the ahead window', () => {
    // From queueIndex 0, indices 1..5 inside → t6 (index 6) is outside.
    expect(isTrackInsideLoudnessBackfillWindow('t6', big, 0, big[0])).toBe(false);
  });

  it('window slides with queueIndex', () => {
    // queueIndex 4, AHEAD 5 → indices 5..9 are inside, t9 must hit, t10 must not.
    expect(isTrackInsideLoudnessBackfillWindow('t9', big, 4, big[4])).toBe(true);
    expect(isTrackInsideLoudnessBackfillWindow('t10', big, 4, big[4])).toBe(false);
  });

  it('returns false for empty queue', () => {
    expect(isTrackInsideLoudnessBackfillWindow('t1', [], 0, null)).toBe(false);
  });

  it('returns false for empty trackId', () => {
    expect(isTrackInsideLoudnessBackfillWindow('', big, 0, big[0])).toBe(false);
  });

  it('returns false when currentTrack is null and id is not in the queue window', () => {
    expect(isTrackInsideLoudnessBackfillWindow('missing', big, 0, null)).toBe(false);
  });
});

describe('collectLoudnessBackfillWindowTrackIds', () => {
  it('returns current + next 5 entries', () => {
    const ids = collectLoudnessBackfillWindowTrackIds(big, 0, big[0]);
    expect(ids).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
  });

  it('clamps the window to the end of the queue', () => {
    const ids = collectLoudnessBackfillWindowTrackIds(big, 9, big[9]);
    // queueIndex 9, AHEAD 5 → indices 10..11 available → t9, t10, t11
    expect(ids).toEqual(['t9', 't10', 't11']);
  });

  it('omits the current track when null', () => {
    const ids = collectLoudnessBackfillWindowTrackIds(big, 0, null);
    expect(ids).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('deduplicates when currentTrack is also in the ahead window', () => {
    const queue = [track('a'), track('b'), track('a'), track('c')];
    const ids = collectLoudnessBackfillWindowTrackIds(queue, 0, queue[0]);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('returns just the current track for an empty queue', () => {
    expect(collectLoudnessBackfillWindowTrackIds([], 0, track('only'))).toEqual(['only']);
  });

  it('returns an empty list when nothing is playing and the queue is empty', () => {
    expect(collectLoudnessBackfillWindowTrackIds([], 0, null)).toEqual([]);
  });
});
