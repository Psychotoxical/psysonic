import type { SubsonicSong } from '../../api/subsonicTypes';

export type PlaylistSortKey = 'natural' | 'title' | 'artist' | 'album' | 'favorite' | 'rating' | 'duration' | 'playCount' | 'lastPlayed' | 'bpm';
export type PlaylistSortDir = 'asc' | 'desc';

export interface DisplayedSongsOptions {
  filterText: string;
  sortKey: PlaylistSortKey;
  sortDir: PlaylistSortDir;
  ratings: Record<string, number>;
  userRatingOverrides: Record<string, number>;
  starredOverrides: Record<string, boolean>;
  starredSongs: Set<string>;
}

export function getDisplayedSongs(songs: SubsonicSong[], opts: DisplayedSongsOptions): SubsonicSong[] {
  const q = opts.filterText.trim().toLowerCase();
  if (!q && opts.sortKey === 'natural') return songs;
  let result = [...songs];
  if (q) result = result.filter(s => s.title.toLowerCase().includes(q) || (s.artist ?? '').toLowerCase().includes(q));
  if (opts.sortKey !== 'natural') {
    result.sort((a, b) => {
      let av: string | number;
      let bv: string | number;
      const effectiveRating = (s: SubsonicSong) => opts.ratings[s.id] ?? opts.userRatingOverrides[s.id] ?? s.userRating ?? 0;
      const effectiveStarred = (s: SubsonicSong) => (s.id in opts.starredOverrides ? opts.starredOverrides[s.id] : opts.starredSongs.has(s.id)) ? 1 : 0;
      switch (opts.sortKey) {
        case 'title': av = a.title; bv = b.title; break;
        case 'artist': av = a.artist ?? ''; bv = b.artist ?? ''; break;
        case 'album': av = a.album ?? ''; bv = b.album ?? ''; break;
        case 'favorite': av = effectiveStarred(a); bv = effectiveStarred(b); break;
        case 'rating': av = effectiveRating(a); bv = effectiveRating(b); break;
        case 'duration': av = a.duration ?? 0; bv = b.duration ?? 0; break;
        case 'playCount': av = a.playCount ?? 0; bv = b.playCount ?? 0; break;
        case 'lastPlayed': av = a.played ? Date.parse(a.played) || 0 : 0; bv = b.played ? Date.parse(b.played) || 0 : 0; break;
        case 'bpm': av = a.bpm ?? 0; bv = b.bpm ?? 0; break;
        default: av = a.title; bv = b.title;
      }
      if (typeof av === 'number' && typeof bv === 'number') {
        return opts.sortDir === 'asc' ? av - bv : bv - av;
      }
      return opts.sortDir === 'asc' ? (av as string).localeCompare(bv as string) : (bv as string).localeCompare(av as string);
    });
  }
  return result;
}
