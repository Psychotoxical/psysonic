import { create } from 'zustand';
import type { AlbumBrowseSort } from '../utils/library/browseTextSearch';

export const DEFAULT_ALBUM_BROWSE_SORT: AlbumBrowseSort = 'alphabeticalByName';

const EMPTY_GENRES: string[] = [];

interface ServerAlbumBrowse {
  sort: AlbumBrowseSort;
  selectedGenres: string[];
}

interface AlbumBrowseSessionStore {
  byServer: Record<string, ServerAlbumBrowse>;
  setSort: (serverId: string, sort: AlbumBrowseSort) => void;
  setSelectedGenres: (serverId: string, genres: string[]) => void;
}

function entryFor(byServer: Record<string, ServerAlbumBrowse>, serverId: string): ServerAlbumBrowse {
  return byServer[serverId] ?? { sort: DEFAULT_ALBUM_BROWSE_SORT, selectedGenres: EMPTY_GENRES };
}

export const useAlbumBrowseSessionStore = create<AlbumBrowseSessionStore>((set) => ({
  byServer: {},

  setSort: (serverId, sort) => {
    if (!serverId) return;
    set((s) => {
      const prev = entryFor(s.byServer, serverId);
      return { byServer: { ...s.byServer, [serverId]: { ...prev, sort } } };
    });
  },

  setSelectedGenres: (serverId, selectedGenres) => {
    if (!serverId) return;
    set((s) => {
      const prev = entryFor(s.byServer, serverId);
      return { byServer: { ...s.byServer, [serverId]: { ...prev, selectedGenres } } };
    });
  },
}));

export function albumBrowseSortForServer(
  byServer: Record<string, ServerAlbumBrowse>,
  serverId: string,
): AlbumBrowseSort {
  if (!serverId) return DEFAULT_ALBUM_BROWSE_SORT;
  return entryFor(byServer, serverId).sort;
}

export function albumBrowseGenresForServer(
  byServer: Record<string, ServerAlbumBrowse>,
  serverId: string,
): string[] {
  if (!serverId) return EMPTY_GENRES;
  return entryFor(byServer, serverId).selectedGenres;
}
