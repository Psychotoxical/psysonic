import { create } from 'zustand';
import { ALL_SENTINEL } from '@/features/artist/utils/artistsHelpers';
import type { ArtistCreditMode } from '@/lib/api/library';

export type ArtistBrowseViewMode = 'grid' | 'list';

/** Browse state restored when returning to Artists via back from artist detail. */
export interface ArtistBrowseReturnState {
  filter: string;
  letterFilter: string;
  starredOnly: boolean;
  creditMode: ArtistCreditMode;
  viewMode: ArtistBrowseViewMode;
  showArtistImages: boolean;
  scrollTop?: number;
  visibleCount?: number;
}

export const DEFAULT_ARTIST_BROWSE_RETURN_STATE: ArtistBrowseReturnState = {
  filter: '',
  letterFilter: ALL_SENTINEL,
  starredOnly: false,
  creditMode: 'album',
  viewMode: 'grid',
  showArtistImages: true,
};

interface ArtistBrowseSessionStore {
  returnStashByServer: Record<string, ArtistBrowseReturnState>;
  stashReturnState: (serverId: string, state: ArtistBrowseReturnState) => void;
  clearReturnStash: (serverId: string) => void;
  peekReturnStash: (serverId: string) => ArtistBrowseReturnState | null;
}

export const useArtistBrowseSessionStore = create<ArtistBrowseSessionStore>((set, get) => ({
  returnStashByServer: {},

  stashReturnState: (serverId, state) => {
    if (!serverId) return;
    set((s) => ({
      returnStashByServer: {
        ...s.returnStashByServer,
        [serverId]: {
          filter: state.filter,
          letterFilter: state.letterFilter,
          starredOnly: state.starredOnly,
          creditMode: state.creditMode,
          viewMode: state.viewMode,
          showArtistImages: state.showArtistImages,
          ...(typeof state.scrollTop === 'number' ? { scrollTop: state.scrollTop } : {}),
          ...(typeof state.visibleCount === 'number' ? { visibleCount: state.visibleCount } : {}),
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
      filter: stash.filter,
      letterFilter: stash.letterFilter,
      starredOnly: stash.starredOnly,
      creditMode: stash.creditMode ?? 'album',
      viewMode: stash.viewMode,
      showArtistImages: stash.showArtistImages,
      ...(typeof stash.scrollTop === 'number' ? { scrollTop: stash.scrollTop } : {}),
      ...(typeof stash.visibleCount === 'number' ? { visibleCount: stash.visibleCount } : {}),
    };
  },
}));

export function peekArtistBrowseScrollRestore(
  serverId: string,
): { scrollTop: number; visibleCount: number } | null {
  const stash = useArtistBrowseSessionStore.getState().peekReturnStash(serverId);
  if (!stash) return null;
  if (typeof stash.scrollTop !== 'number' || typeof stash.visibleCount !== 'number') return null;
  return {
    scrollTop: Math.max(0, stash.scrollTop),
    visibleCount: Math.max(0, stash.visibleCount),
  };
}

/** True when pathname is the Artists browse route (`/artists`). */
export function isArtistsBrowsePath(pathname: string): boolean {
  return pathname === '/artists';
}
