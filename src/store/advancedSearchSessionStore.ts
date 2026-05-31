import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '../api/subsonicTypes';
import { create } from 'zustand';

export type AdvancedSearchResultType = 'all' | 'artists' | 'albums' | 'songs';

export type AdvancedSearchFormStash = {
  query: string;
  genre: string;
  yearFrom: string;
  yearTo: string;
  bpmFrom: string;
  bpmTo: string;
  moodGroup: string;
  losslessOnly: boolean;
  resultType: AdvancedSearchResultType;
  starredOnly: boolean;
};

export type AdvancedSearchQueryStash = Omit<AdvancedSearchFormStash, 'starredOnly'>;

export type AdvancedSearchResultsStash = {
  artists: SubsonicArtist[];
  albums: SubsonicAlbum[];
  songs: SubsonicSong[];
};

/** Session snapshot when leaving Advanced Search → album detail. */
export type AdvancedSearchSessionStash = AdvancedSearchFormStash & {
  results: AdvancedSearchResultsStash | null;
  hasSearched: boolean;
  activeSearch: AdvancedSearchQueryStash | null;
  localMode: boolean;
  songsServerOffset: number;
  songsHasMore: boolean;
  genreNote: boolean;
};

interface AdvancedSearchSessionStore {
  returnStash: AdvancedSearchSessionStash | null;
  stashReturnSession: (stash: AdvancedSearchSessionStash) => void;
  peekReturnStash: () => AdvancedSearchSessionStash | null;
  clearReturnStash: () => void;
}

export const useAdvancedSearchSessionStore = create<AdvancedSearchSessionStore>((set, get) => ({
  returnStash: null,

  stashReturnSession: (stash) => {
    set({
      returnStash: {
        ...stash,
        results: stash.results
          ? {
              artists: [...stash.results.artists],
              albums: [...stash.results.albums],
              songs: [...stash.results.songs],
            }
          : null,
        activeSearch: stash.activeSearch ? { ...stash.activeSearch } : null,
      },
    });
  },

  clearReturnStash: () => set({ returnStash: null }),

  peekReturnStash: () => {
    const stash = get().returnStash;
    if (!stash) return null;
    return {
      ...stash,
      results: stash.results
        ? {
            artists: [...stash.results.artists],
            albums: [...stash.results.albums],
            songs: [...stash.results.songs],
          }
        : null,
      activeSearch: stash.activeSearch ? { ...stash.activeSearch } : null,
    };
  },
}));

/** True when pathname is Advanced Search (`/search/advanced`). */
export function isAdvancedSearchPath(pathname: string): boolean {
  return pathname === '/search/advanced';
}
