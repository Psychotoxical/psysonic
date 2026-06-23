import { create } from 'zustand';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import type { AlbumBrowseSort } from '../utils/library/browseTextSearch';

export const DEFAULT_ALBUM_BROWSE_SORT: AlbumBrowseSort = 'alphabeticalByName';

export type AlbumBrowseCompFilter = 'all' | 'only' | 'hide';

/** Album grid browse surfaces that share leave-restore session behavior. */
export type AlbumBrowseSurface = 'albums' | 'new-releases' | 'random-albums';

/** Browse state restored when returning via browser/app back from album detail. */
export interface AlbumBrowseReturnFilters {
  selectedGenres: string[];
  yearFrom: string;
  yearTo: string;
  compFilter: AlbumBrowseCompFilter;
  starredOnly: boolean;
  losslessOnly: boolean;
  /** Header live search query when leaving for album detail (All Albums scope). */
  searchQuery?: string;
  /** In-page grid scroll position when leaving the browse surface. */
  scrollTop?: number;
  /** Row count at leave time — preload at least this many rows before scroll. */
  displayCount?: number;
  /** Cached grid rows (New Releases / Random Albums). */
  albums?: SubsonicAlbum[];
  hasMore?: boolean;
}

export const DEFAULT_ALBUM_BROWSE_RETURN_FILTERS: AlbumBrowseReturnFilters = {
  selectedGenres: [],
  yearFrom: '',
  yearTo: '',
  compFilter: 'all',
  starredOnly: false,
  losslessOnly: false,
};


interface AlbumBrowseSessionStore {
  /** Session-lifetime sort per server (sidebar ↔ album detail). */
  sortByServer: Record<string, AlbumBrowseSort>;
  /** Stashed when leaving a browse surface → album detail; consumed after scroll restore. */
  returnStashByKey: Record<string, AlbumBrowseReturnFilters>;
  setSort: (serverId: string, sort: AlbumBrowseSort) => void;
  stashReturnFilters: (
    serverId: string,
    surface: AlbumBrowseSurface,
    filters: AlbumBrowseReturnFilters,
  ) => void;
  clearReturnStash: (serverId: string, surface: AlbumBrowseSurface) => void;
  peekReturnStash: (serverId: string, surface: AlbumBrowseSurface) => AlbumBrowseReturnFilters | null;
}

function returnStashKey(serverId: string, surface: AlbumBrowseSurface): string {
  return `${serverId}:${surface}`;
}

function genreDetailStashKey(serverId: string, genreName: string): string {
  return `${serverId}:genre-detail:${genreName}`;
}

function sortEntryFor(
  sortByServer: Record<string, AlbumBrowseSort>,
  serverId: string,
): AlbumBrowseSort {
  return sortByServer[serverId] ?? DEFAULT_ALBUM_BROWSE_SORT;
}

function cloneReturnFilters(filters: AlbumBrowseReturnFilters): AlbumBrowseReturnFilters {
  return {
    selectedGenres: [...filters.selectedGenres],
    yearFrom: filters.yearFrom,
    yearTo: filters.yearTo,
    compFilter: filters.compFilter,
    starredOnly: filters.starredOnly,
    losslessOnly: filters.losslessOnly,
    ...(typeof filters.searchQuery === 'string' ? { searchQuery: filters.searchQuery } : {}),
    ...(typeof filters.scrollTop === 'number' ? { scrollTop: filters.scrollTop } : {}),
    ...(typeof filters.displayCount === 'number' ? { displayCount: filters.displayCount } : {}),
    ...(filters.albums ? { albums: [...filters.albums] } : {}),
    ...(typeof filters.hasMore === 'boolean' ? { hasMore: filters.hasMore } : {}),
  };
}

export const useAlbumBrowseSessionStore = create<AlbumBrowseSessionStore>((set, get) => ({
  sortByServer: {},
  returnStashByKey: {},

  setSort: (serverId, sort) => {
    if (!serverId) return;
    set((s) => ({
      sortByServer: { ...s.sortByServer, [serverId]: sort },
    }));
  },

  stashReturnFilters: (serverId, surface, filters) => {
    if (!serverId) return;
    const key = returnStashKey(serverId, surface);
    set((s) => ({
      returnStashByKey: {
        ...s.returnStashByKey,
        [key]: cloneReturnFilters(filters),
      },
    }));
  },

  clearReturnStash: (serverId, surface) => {
    if (!serverId) return;
    const key = returnStashKey(serverId, surface);
    const next = { ...get().returnStashByKey };
    delete next[key];
    set({ returnStashByKey: next });
  },

  peekReturnStash: (serverId, surface) => {
    if (!serverId) return null;
    const stash = get().returnStashByKey[returnStashKey(serverId, surface)];
    if (!stash) return null;
    return cloneReturnFilters(stash);
  },
}));

/** Scroll-restore target saved when leaving a browse surface for album detail. */
export function peekAlbumBrowseScrollRestore(
  serverId: string,
  surface: AlbumBrowseSurface,
): { scrollTop: number; displayCount: number } | null {
  const stash = useAlbumBrowseSessionStore.getState().peekReturnStash(serverId, surface);
  if (!stash) return null;
  if (typeof stash.scrollTop !== 'number' || typeof stash.displayCount !== 'number') return null;
  return {
    scrollTop: Math.max(0, stash.scrollTop),
    displayCount: Math.max(0, stash.displayCount),
  };
}

/** Genre detail leave-restore (scoped per genre name). */
export function stashGenreDetailReturnFilters(
  serverId: string,
  genreName: string,
  filters: AlbumBrowseReturnFilters,
): void {
  if (!serverId || !genreName) return;
  const key = genreDetailStashKey(serverId, genreName);
  useAlbumBrowseSessionStore.setState((s) => ({
    returnStashByKey: {
      ...s.returnStashByKey,
      [key]: cloneReturnFilters(filters),
    },
  }));
}

export function clearGenreDetailReturnStash(serverId: string, genreName: string): void {
  if (!serverId || !genreName) return;
  const key = genreDetailStashKey(serverId, genreName);
  useAlbumBrowseSessionStore.setState((s) => {
    const next = { ...s.returnStashByKey };
    delete next[key];
    return { returnStashByKey: next };
  });
}

export function peekGenreDetailReturnStash(
  serverId: string,
  genreName: string,
): AlbumBrowseReturnFilters | null {
  if (!serverId || !genreName) return null;
  const stash = useAlbumBrowseSessionStore.getState().returnStashByKey[genreDetailStashKey(serverId, genreName)];
  if (!stash) return null;
  return cloneReturnFilters(stash);
}

export function peekGenreDetailScrollRestore(
  serverId: string,
  genreName: string,
): { scrollTop: number; displayCount: number } | null {
  const stash = peekGenreDetailReturnStash(serverId, genreName);
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

/** Map pathname to album grid browse surface, if any. */
/** All Albums browse route (`/albums`) — scoped live search target. */
export function isAlbumsBrowsePath(pathname: string): boolean {
  return albumBrowseSurfaceForPath(pathname) === 'albums';
}

/** New Releases browse route (`/new-releases`) — scoped live search target. */
export function isNewReleasesBrowsePath(pathname: string): boolean {
  return albumBrowseSurfaceForPath(pathname) === 'new-releases';
}

export function albumBrowseSurfaceForPath(pathname: string): AlbumBrowseSurface | null {
  const path = pathname.split('?')[0]?.replace(/\/$/, '') || pathname;
  if (path === '/albums') return 'albums';
  if (path === '/new-releases') return 'new-releases';
  if (path === '/random/albums') return 'random-albums';
  return null;
}

/** True when pathname is a single album detail route (`/album/:id`). */
export function isAlbumDetailPath(pathname: string): boolean {
  return /^\/album\/[^/]+\/?$/.test(pathname.split('?')[0]?.replace(/\/$/, '') || pathname);
}

/** Single genre detail route (`/genres/:name`), not the genre cloud (`/genres`). */
export function isGenreDetailPath(pathname: string): boolean {
  const path = pathname.split('?')[0]?.replace(/\/$/, '') || pathname;
  return /^\/genres\/[^/]+$/.test(path);
}

export function genreDetailGenreFromPath(pathname: string): string | null {
  const path = pathname.split('?')[0]?.replace(/\/$/, '') || pathname;
  const match = path.match(/^\/genres\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** True when pathname is a single artist detail route (`/artist/:id`). */
export function isArtistDetailPath(pathname: string): boolean {
  return /^\/artist\/[^/]+\/?$/.test(pathname);
}

/** True when pathname is a single composer detail route (`/composer/:id`). */
export function isComposerDetailPath(pathname: string): boolean {
  return /^\/composer\/[^/]+\/?$/.test(pathname);
}

export function isAdvancedSearchLeaveTargetPath(pathname: string): boolean {
  return isAlbumDetailPath(pathname) || isArtistDetailPath(pathname) || isComposerDetailPath(pathname);
}
