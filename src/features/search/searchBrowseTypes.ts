import type { SubsonicArtist, SubsonicAlbum, SubsonicSong } from '@/lib/api/subsonicTypes';

/** Result-scope filter for the advanced/basic search shell. */
export type ResultType = 'all' | 'artists' | 'albums' | 'songs';

/** The full filter snapshot a search run executes against. */
export interface SearchOpts {
  query: string;
  genre: string;
  yearFrom: string;
  yearTo: string;
  bpmFrom: string;
  bpmTo: string;
  moodGroup: string;
  losslessOnly: boolean;
  resultType: ResultType;
}

/** Combined artist/album/song result set rendered by the search shell. */
export interface Results {
  artists: SubsonicArtist[];
  albums: SubsonicAlbum[];
  songs: SubsonicSong[];
}
