import { create } from 'zustand';
import type { AlbumBrowseSort } from '../utils/library/browseTextSearch';

export const DEFAULT_ALBUM_BROWSE_SORT: AlbumBrowseSort = 'alphabeticalByName';

export type AlbumBrowseCompFilter = 'all' | 'only' | 'hide';

/** Filters restored only when returning to Albums via browser/app back from album detail. */
export interface AlbumBrowseReturnFilters {
  selectedGenres: string[];
  yearFrom: string;
  yearTo: string;
  compFilter: AlbumBrowseCompFilter;
  starredOnly: boolean;
  losslessOnly: boolean;
}

export const DEFAULT_ALBUM_BROWSE_RETURN_FILTERS: AlbumBrowseReturnFilters = {
  selectedGenres: [],
  yearFrom: '',
  yearTo: '',
  compFilter: 'all',
  starredOnly: false,
  losslessOnly: false,
};

interface ServerAlbumBrowseSession {
  sort: AlbumBrowseSort;
}

interface AlbumBrowseSessionStore {
  /** Session-lifetime sort per server (sidebar ↔ album detail). */
  sortByServer: Record<string, AlbumBrowseSort>;
  /** Stashed when leaving Albums → album detail; consumed on POP back. */
  returnStashByServer: Record<string, AlbumBrowseReturnFilters>;
  setSort: (serverId: string, sort: AlbumBrowseSort) => void;
  stashReturnFilters: (serverId: string, filters: AlbumBrowseReturnFilters) => void;
  clearReturnStash: (serverId: string) => void;
  peekReturnStash: (serverId: string) => AlbumBrowseReturnFilters | null;
}

function sortEntryFor(
  sortByServer: Record<string, AlbumBrowseSort>,
  serverId: string,
): AlbumBrowseSort {
  return sortByServer[serverId] ?? DEFAULT_ALBUM_BROWSE_SORT;
}

export const useAlbumBrowseSessionStore = create<AlbumBrowseSessionStore>((set, get) => ({
  sortByServer: {},
  returnStashByServer: {},

  setSort: (serverId, sort) => {
    if (!serverId) return;
    set((s) => ({
      sortByServer: { ...s.sortByServer, [serverId]: sort },
    }));
  },

  stashReturnFilters: (serverId, filters) => {
    if (!serverId) return;
    set((s) => ({
      returnStashByServer: {
        ...s.returnStashByServer,
        [serverId]: {
          selectedGenres: [...filters.selectedGenres],
          yearFrom: filters.yearFrom,
          yearTo: filters.yearTo,
          compFilter: filters.compFilter,
          starredOnly: filters.starredOnly,
          losslessOnly: filters.losslessOnly,
        },
      },
    }));
  },

  clearReturnStash: (serverId) => {
    if (!serverId) return;
    const next = { ...get().returnStashByServer };
    delete next[serverId];
    set({ returnStashByServer: next });
  },

  peekReturnStash: (serverId) => {
    if (!serverId) return null;
    const stash = get().returnStashByServer[serverId];
    if (!stash) return null;
    return {
      selectedGenres: [...stash.selectedGenres],
      yearFrom: stash.yearFrom,
      yearTo: stash.yearTo,
      compFilter: stash.compFilter,
      starredOnly: stash.starredOnly,
      losslessOnly: stash.losslessOnly,
    };
  },
}));

export function albumBrowseSortForServer(
  sortByServer: Record<string, AlbumBrowseSort>,
  serverId: string,
): AlbumBrowseSort {
  if (!serverId) return DEFAULT_ALBUM_BROWSE_SORT;
  return sortEntryFor(sortByServer, serverId);
}

/** True when pathname is a single album detail route (`/album/:id`). */
export function isAlbumDetailPath(pathname: string): boolean {
  return /^\/album\/[^/]+\/?$/.test(pathname);
}
