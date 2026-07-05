import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '@/lib/api/subsonicTypes';
import { create } from 'zustand';
import type { AdvancedSearchLeaveSnapshot } from '@/lib/navigation/advancedSearchScrollSnapshot';

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

/** Session snapshot when leaving Search → album/artist detail. */
export type AdvancedSearchSessionStash = AdvancedSearchFormStash & {
  results: AdvancedSearchResultsStash | null;
  hasSearched: boolean;
  activeSearch: AdvancedSearchQueryStash | null;
  localMode: boolean;
  songsServerOffset: number;
  songsHasMore: boolean;
  genreNote: boolean;
  /** `/search?q=` quick results (no advanced filter panel). */
  basicSearchMode: boolean;
  /** `/tracks` hub — browse-all list with toolbar filter. */
  tracksBrowseMode: boolean;
  tracksBrowseUnsupported?: boolean;
  scrollTop?: number;
  albumRowScrollLeft?: number;
  artistRowScrollLeft?: number;
};

interface AdvancedSearchSessionStore {
  returnStash: AdvancedSearchSessionStash | null;
  leaveScrollSnapshot: AdvancedSearchLeaveSnapshot | null;
  stashReturnSession: (stash: AdvancedSearchSessionStash) => void;
  peekReturnStash: () => AdvancedSearchSessionStash | null;
  clearReturnStash: () => void;
  setLeaveScrollSnapshot: (snapshot: AdvancedSearchLeaveSnapshot) => void;
  peekLeaveScrollSnapshot: () => AdvancedSearchLeaveSnapshot | null;
  clearLeaveScrollSnapshot: () => void;
}

export const useAdvancedSearchSessionStore = create<AdvancedSearchSessionStore>((set, get) => ({
  returnStash: null,
  leaveScrollSnapshot: null,

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
        ...(typeof stash.scrollTop === 'number' ? { scrollTop: stash.scrollTop } : {}),
        ...(typeof stash.albumRowScrollLeft === 'number'
          ? { albumRowScrollLeft: stash.albumRowScrollLeft }
          : {}),
        ...(typeof stash.artistRowScrollLeft === 'number'
          ? { artistRowScrollLeft: stash.artistRowScrollLeft }
          : {}),
      },
    });
  },

  clearReturnStash: () => set({ returnStash: null }),

  setLeaveScrollSnapshot: (snapshot) => set({ leaveScrollSnapshot: { ...snapshot } }),

  clearLeaveScrollSnapshot: () => set({ leaveScrollSnapshot: null }),

  peekLeaveScrollSnapshot: () => {
    const snapshot = get().leaveScrollSnapshot;
    return snapshot ? { ...snapshot } : null;
  },

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
      ...(typeof stash.scrollTop === 'number' ? { scrollTop: stash.scrollTop } : {}),
      ...(typeof stash.albumRowScrollLeft === 'number'
        ? { albumRowScrollLeft: stash.albumRowScrollLeft }
        : {}),
      ...(typeof stash.artistRowScrollLeft === 'number'
        ? { artistRowScrollLeft: stash.artistRowScrollLeft }
        : {}),
    };
  },
}));

/** True when pathname is the unified search page (`/search`, `/search/advanced`, or `/tracks`). */
export function isAdvancedSearchPath(pathname: string): boolean {
  return pathname === '/search' || pathname === '/search/advanced' || pathname === '/tracks';
}

/** True when pathname is the Tracks hub (`/tracks`). */
export function isTracksBrowsePath(pathname: string): boolean {
  return pathname === '/tracks';
}

/** True when the advanced filter panel should be shown. */
export function isAdvancedSearchPanelPath(pathname: string): boolean {
  return pathname === '/search/advanced';
}
