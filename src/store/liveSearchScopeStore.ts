import { create } from 'zustand';

/** Page-scoped live search mode — badge in the header search field. */
export type LiveSearchScope = 'artists' | 'albums' | 'newReleases' | 'tracks' | 'composers' | 'playlists';

export type LiveSearchSnapshot = {
  query: string;
  scope: LiveSearchScope | null;
};

type LiveSearchMutationOpts = {
  /** Push the current field state onto the search-local undo stack. */
  recordUndo?: boolean;
};

interface LiveSearchScopeStore {
  query: string;
  scope: LiveSearchScope | null;
  undoStack: LiveSearchSnapshot[];
  setQuery: (query: string, options?: LiveSearchMutationOpts) => void;
  setScope: (scope: LiveSearchScope | null, options?: LiveSearchMutationOpts) => void;
  clearScope: (options?: LiveSearchMutationOpts) => void;
  recordUndoSnapshot: () => void;
  undo: () => boolean;
}

const MAX_UNDO = 50;

function snapshotsEqual(a: LiveSearchSnapshot, b: LiveSearchSnapshot): boolean {
  return a.query === b.query && a.scope === b.scope;
}

export const useLiveSearchScopeStore = create<LiveSearchScopeStore>((set, get) => ({
  query: '',
  scope: null,
  undoStack: [],

  recordUndoSnapshot: () => {
    const snap: LiveSearchSnapshot = { query: get().query, scope: get().scope };
    set((s) => {
      const last = s.undoStack[s.undoStack.length - 1];
      if (last && snapshotsEqual(last, snap)) return s;
      return { undoStack: [...s.undoStack, snap].slice(-MAX_UNDO) };
    });
  },

  setQuery: (query, options) => {
    if (get().query === query) return;
    if (options?.recordUndo) get().recordUndoSnapshot();
    set({ query });
  },

  setScope: (scope, options) => {
    if (get().scope === scope) return;
    if (options?.recordUndo) get().recordUndoSnapshot();
    set({ scope });
  },

  clearScope: (options) => {
    if (get().scope == null) return;
    if (options?.recordUndo) get().recordUndoSnapshot();
    set({ scope: null });
  },

  undo: () => {
    const stack = get().undoStack;
    if (stack.length === 0) return false;
    const prev = stack[stack.length - 1]!;
    set({ query: prev.query, scope: prev.scope, undoStack: stack.slice(0, -1) });
    return true;
  },
}));

/** Browse filter text when the header scope badge matches the page. */
export function scopedBrowseSearchQuery(
  query: string,
  activeScope: LiveSearchScope | null,
  expectedScope: LiveSearchScope,
): string {
  return activeScope === expectedScope ? query : '';
}

export function useScopedBrowseSearchQuery(expectedScope: LiveSearchScope): string {
  const query = useLiveSearchScopeStore(s => s.query);
  const scope = useLiveSearchScopeStore(s => s.scope);
  return scopedBrowseSearchQuery(query, scope, expectedScope);
}
