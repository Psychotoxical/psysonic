import { describe, expect, it } from 'vitest';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import {
  nextArtistAllTracksSort,
  sortArtistAllTracks,
  type ArtistAllTracksSortState,
} from '@/features/artist/utils/artistAllTracksSort';

function song(partial: Partial<SubsonicSong> & { id: string }): SubsonicSong {
  return {
    title: '', album: '', albumId: '', artist: '', duration: 0, ...partial,
  } as SubsonicSong;
}

const NATURAL: ArtistAllTracksSortState = { key: 'natural', dir: 'asc' };

describe('sortArtistAllTracks', () => {
  // The index already returns album/track order; re-sorting it would be work for
  // nothing and would lose that ordering's disc grouping.
  it('hands back the original order untouched for the natural key', () => {
    const songs = [song({ id: 'b', title: 'B' }), song({ id: 'a', title: 'A' })];
    expect(sortArtistAllTracks(songs, NATURAL)).toBe(songs);
  });

  it('sorts text ascending and descending', () => {
    const songs = [song({ id: '1', title: 'Kilo' }), song({ id: '2', title: 'Alpha' })];
    expect(sortArtistAllTracks(songs, { key: 'title', dir: 'asc' }).map(s => s.id)).toEqual(['2', '1']);
    expect(sortArtistAllTracks(songs, { key: 'title', dir: 'desc' }).map(s => s.id)).toEqual(['1', '2']);
  });

  // Mixed capitalisation must not form its own block, the way a raw codepoint
  // comparison would order it — the query collates case-insensitively too.
  it('ignores case when comparing text', () => {
    const songs = [song({ id: '1', title: 'beta' }), song({ id: '2', title: 'Alpha' })];
    expect(sortArtistAllTracks(songs, { key: 'title', dir: 'asc' }).map(s => s.id)).toEqual(['2', '1']);
  });

  it('sorts numeric columns by value, not by text', () => {
    const songs = [song({ id: '1', duration: 100 }), song({ id: '2', duration: 20 })];
    expect(sortArtistAllTracks(songs, { key: 'duration', dir: 'asc' }).map(s => s.id)).toEqual(['2', '1']);
  });

  it('treats a missing value as zero rather than dropping the row', () => {
    const songs = [song({ id: 'has', playCount: 5 }), song({ id: 'none' })];
    const asc = sortArtistAllTracks(songs, { key: 'playCount', dir: 'asc' });
    expect(asc.map(s => s.id)).toEqual(['none', 'has']);
    expect(asc).toHaveLength(2);
  });

  it('reads lastPlayed as a date', () => {
    const songs = [
      song({ id: 'old', played: '2020-01-01T00:00:00Z' }),
      song({ id: 'new', played: '2026-01-01T00:00:00Z' }),
    ];
    expect(sortArtistAllTracks(songs, { key: 'lastPlayed', dir: 'desc' }).map(s => s.id)).toEqual(['new', 'old']);
  });

  // Reversing the sorted array would also flip rows that compare equal, so the
  // two directions would disagree about their relative order. Negating the
  // comparator keeps ties in place.
  it('keeps tied rows in the same relative order in both directions', () => {
    const songs = [
      song({ id: 'first', duration: 60 }),
      song({ id: 'second', duration: 60 }),
      song({ id: 'third', duration: 10 }),
    ];
    const asc = sortArtistAllTracks(songs, { key: 'duration', dir: 'asc' });
    const desc = sortArtistAllTracks(songs, { key: 'duration', dir: 'desc' });
    expect(asc.filter(s => s.duration === 60).map(s => s.id)).toEqual(['first', 'second']);
    expect(desc.filter(s => s.duration === 60).map(s => s.id)).toEqual(['first', 'second']);
  });

  it('leaves the input array alone', () => {
    const songs = [song({ id: '1', title: 'Zulu' }), song({ id: '2', title: 'Alpha' })];
    sortArtistAllTracks(songs, { key: 'title', dir: 'asc' });
    expect(songs.map(s => s.id)).toEqual(['1', '2']);
  });
});

describe('nextArtistAllTracksSort', () => {
  it('starts a new column ascending', () => {
    expect(nextArtistAllTracksSort(NATURAL, 'title')).toEqual({ key: 'title', dir: 'asc' });
  });

  it('flips to descending on the second click', () => {
    expect(nextArtistAllTracksSort({ key: 'title', dir: 'asc' }, 'title')).toEqual({ key: 'title', dir: 'desc' });
  });

  // The third click returns to the index order rather than cycling back to
  // ascending, so there is always a way back to the album grouping.
  it('returns to the natural order on the third click', () => {
    expect(nextArtistAllTracksSort({ key: 'title', dir: 'desc' }, 'title')).toEqual({ key: 'natural', dir: 'asc' });
  });

  it('switching columns starts over ascending', () => {
    expect(nextArtistAllTracksSort({ key: 'title', dir: 'desc' }, 'album')).toEqual({ key: 'album', dir: 'asc' });
  });
});
