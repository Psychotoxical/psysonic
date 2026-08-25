import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import type { ArtistAllTracksSortKey } from '@/features/artist/utils/artistAllTracksColumns';

export type ArtistAllTracksSortDir = 'asc' | 'desc';

export interface ArtistAllTracksSortState {
  key: ArtistAllTracksSortKey;
  dir: ArtistAllTracksSortDir;
}

/**
 * `natural` is the order the index returned: album, then track number, then
 * title — a discography read the way the records are pressed. Every other key
 * sorts the flat list.
 *
 * Deliberately not reusing the playlist sorter: that one carries ratings, starred
 * overrides and a playlist-position mode this read-only list has no input for.
 * If a third caller ever needs this, the two belong in one shared helper.
 */
export function sortArtistAllTracks(
  songs: SubsonicSong[],
  { key, dir }: ArtistAllTracksSortState,
): SubsonicSong[] {
  if (key === 'natural') return songs;

  const text = (value: string | undefined) => value ?? '';
  // Case-insensitive like the query's `COLLATE NOCASE`, so a lowercase title does
  // not land in its own block below the rest.
  const byText = (a: string | undefined, b: string | undefined) =>
    text(a).localeCompare(text(b), undefined, { sensitivity: 'base' });
  const compare = (a: SubsonicSong, b: SubsonicSong): number => {
    switch (key) {
      case 'title':  return byText(a.title, b.title);
      case 'album':  return byText(a.album, b.album);
      case 'artist': return byText(a.artist, b.artist);
      case 'duration':  return (a.duration ?? 0) - (b.duration ?? 0);
      case 'year':      return (a.year ?? 0) - (b.year ?? 0);
      case 'playCount': return (a.playCount ?? 0) - (b.playCount ?? 0);
      case 'bpm':       return (a.bpm ?? 0) - (b.bpm ?? 0);
      case 'lastPlayed': {
        const at = a.played ? Date.parse(a.played) || 0 : 0;
        const bt = b.played ? Date.parse(b.played) || 0 : 0;
        return at - bt;
      }
      default: return 0;
    }
  };

  // Negating the comparator rather than reversing the result: `reverse()` would
  // also flip rows that compare equal, so tracks sharing a value would shuffle
  // between the two directions instead of holding their place.
  // Sorting a copy keeps the natural order intact — switching back needs no reload.
  const sign = dir === 'asc' ? 1 : -1;
  return [...songs].sort((a, b) => sign * compare(a, b));
}

/** Click cycle of a column header: ascending, descending, then back to natural. */
export function nextArtistAllTracksSort(
  current: ArtistAllTracksSortState,
  clicked: ArtistAllTracksSortKey,
): ArtistAllTracksSortState {
  if (current.key !== clicked) return { key: clicked, dir: 'asc' };
  if (current.dir === 'asc') return { key: clicked, dir: 'desc' };
  return { key: 'natural', dir: 'asc' };
}
