import { create } from 'zustand';
import type { AlbumBrowseSort } from '../utils/library/browseTextSearch';

export const DEFAULT_ALBUM_BROWSE_SORT: AlbumBrowseSort = 'alphabeticalByName';

export type AlbumBrowseCompFilter = 'all' | 'only' | 'hide';

/** Browse state restored when returning to Albums via browser/app back from album detail. */
export interface AlbumBrowseReturnFilters {
  selectedGenres: string[];
  yearFrom: string;
  yearTo: string;
  compFilter: AlbumBrowseCompFilter;
  starredOnly: boolean;
  losslessOnly: boolean;
  /** In-page grid scroll position when leaving All Albums. */
  scrollTop?: number;
  /** `displayAlbums.length` at leave time — preload at least this many rows before scroll. */
  displayCount?: number;
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
  /** Stashed when leaving Albums → album detail; consumed after POP scroll restore. */
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
          ...(typeof filters.scrollTop === 'number'
            ? { scrollTop: filters.scrollTop }
            : {}),
          ...(typeof filters.displayCount === 'number'
            ? { displayCount: filters.displayCount }
            : {}),
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
      ...(typeof stash.scrollTop === 'number' ? { scrollTop: stash.scrollTop } : {}),
      ...(typeof stash.displayCount === 'number' ? { displayCount: stash.displayCount } : {}),
    };
  },
}));

/** Scroll-restore target saved when leaving All Albums for album detail. */
export function peekAlbumBrowseScrollRestore(
  serverId: string,
): { scrollTop: number; displayCount: number } | null {
  const stash = useAlbumBrowseSessionStore.getState().peekReturnStash(serverId);
  if (!stash) return null;
  if (typeof stash.scrollTop !== 'number' || typeof stash.displayCount !== 'number') return null;
  return {
    scrollTop: Math.max(0, stash.scrollTop),
    displayCount: Math.max(0, stash.displayCount),
  };
}

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

/** True when pathname is a single artist detail route (`/artist/:id`). */
export function isArtistDetailPath(pathname: string): boolean {
  return /^\/artist\/[^/]+\/?$/.test(pathname);
}

export function isAdvancedSearchLeaveTargetPath(pathname: string): boolean {
  return isAlbumDetailPath(pathname) || isArtistDetailPath(pathname);
}
