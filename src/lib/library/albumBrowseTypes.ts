import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import type { AlbumYearBounds } from './albumYearFilter';
import type { AlbumCompFilter } from './albumCompilation';
import type { AlbumBrowseSort } from './albumBrowseSort';

export const GENRE_ALBUM_FETCH_LIMIT = 500;

export type AlbumBrowseQuery = {
  sort: AlbumBrowseSort;
  genres: string[];
  year?: AlbumYearBounds;
  losslessOnly: boolean;
  starredOnly: boolean;
  compFilter: AlbumCompFilter;
};

export type AlbumBrowsePageResult = {
  albums: SubsonicAlbum[];
  hasMore: boolean;
};

export type AlbumBrowseFetchCallbacks = {
  /** Earlier page (cache / local index) before server favorites refresh finishes. */
  onPartial?: (page: AlbumBrowsePageResult) => void;
};

export type GenreFilterOption = {
  genre: string;
  count: number;
};
