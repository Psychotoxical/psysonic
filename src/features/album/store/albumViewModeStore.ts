import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Album list rendering: cover grid or metadata table. */
export type AlbumViewMode = 'grid' | 'table';

/** Catalogue pages that carry the grid/table switch. */
export type AlbumViewModeSurface = 'albums' | 'new-releases' | 'lossless';

export const DEFAULT_ALBUM_VIEW_MODE: AlbumViewMode = 'grid';

const SURFACES: readonly AlbumViewModeSurface[] = ['albums', 'new-releases', 'lossless'];

function isAlbumViewMode(value: unknown): value is AlbumViewMode {
  return value === 'grid' || value === 'table';
}

/**
 * Keeps only known surfaces with known modes. Persisted state outlives the
 * code that wrote it: a renamed surface or a mode dropped in a later version
 * must not leave the page rendering nothing.
 */
export function sanitizeAlbumViewModes(
  value: unknown,
): Partial<Record<AlbumViewModeSurface, AlbumViewMode>> {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  const out: Partial<Record<AlbumViewModeSurface, AlbumViewMode>> = {};
  for (const surface of SURFACES) {
    const mode = source[surface];
    if (isAlbumViewMode(mode)) out[surface] = mode;
  }
  return out;
}

interface AlbumViewModeStore {
  /** Per-page mode; a missing entry means the default. */
  modeBySurface: Partial<Record<AlbumViewModeSurface, AlbumViewMode>>;
  setViewMode: (surface: AlbumViewModeSurface, mode: AlbumViewMode) => void;
}

export const useAlbumViewModeStore = create<AlbumViewModeStore>()(
  persist(
    (set) => ({
      modeBySurface: {},
      setViewMode: (surface, mode) =>
        set((s) => ({ modeBySurface: { ...s.modeBySurface, [surface]: mode } })),
    }),
    {
      name: 'psysonic_album_view_mode',
      version: 1,
      merge: (persistedState, currentState) => ({
        ...currentState,
        modeBySurface: sanitizeAlbumViewModes(
          (persistedState as { modeBySurface?: unknown } | undefined)?.modeBySurface,
        ),
      }),
    },
  ),
);

/** Subscribe to one page's mode. */
export function useAlbumViewMode(surface: AlbumViewModeSurface): AlbumViewMode {
  return useAlbumViewModeStore((s) => s.modeBySurface[surface] ?? DEFAULT_ALBUM_VIEW_MODE);
}
