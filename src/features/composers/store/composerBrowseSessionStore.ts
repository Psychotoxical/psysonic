import { create } from 'zustand';
import { ALL_SENTINEL } from '@/features/artist';

export type ComposerBrowseViewMode = 'grid' | 'list';

/** Browse state restored when returning to Composers via back from composer detail. */
export interface ComposerBrowseReturnState {
  filter: string;
  letterFilter: string;
  starredOnly: boolean;
  viewMode: ComposerBrowseViewMode;
  scrollTop?: number;
  visibleCount?: number;
}

export const DEFAULT_COMPOSER_BROWSE_RETURN_STATE: ComposerBrowseReturnState = {
  filter: '',
  letterFilter: ALL_SENTINEL,
  starredOnly: false,
  viewMode: 'grid',
};

interface ComposerBrowseSessionStore {
  returnStashByServer: Record<string, ComposerBrowseReturnState>;
  stashReturnState: (serverId: string, state: ComposerBrowseReturnState) => void;
  clearReturnStash: (serverId: string) => void;
  peekReturnStash: (serverId: string) => ComposerBrowseReturnState | null;
}

export const useComposerBrowseSessionStore = create<ComposerBrowseSessionStore>((set, get) => ({
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
          viewMode: state.viewMode,
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
      viewMode: stash.viewMode,
      ...(typeof stash.scrollTop === 'number' ? { scrollTop: stash.scrollTop } : {}),
      ...(typeof stash.visibleCount === 'number' ? { visibleCount: stash.visibleCount } : {}),
    };
  },
}));

export function peekComposerBrowseScrollRestore(
  serverId: string,
): { scrollTop: number; visibleCount: number } | null {
  const stash = useComposerBrowseSessionStore.getState().peekReturnStash(serverId);
  if (!stash) return null;
  if (typeof stash.scrollTop !== 'number' || typeof stash.visibleCount !== 'number') return null;
  return {
    scrollTop: Math.max(0, stash.scrollTop),
    visibleCount: Math.max(0, stash.visibleCount),
  };
}

/** True when pathname is the Composers browse route (`/composers`). */
export function isComposersBrowsePath(pathname: string): boolean {
  return pathname === '/composers';
}
