import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * A community theme the user installed from the Theme Store. The full CSS text
 * lives here (in localStorage via the persist middleware) so it is available
 * *synchronously* at startup — the runtime <style> injection can run before the
 * first paint with no network round-trip and no flash of the wrong theme.
 * Built-in themes are NOT tracked here; they ship bundled and are never
 * uninstallable.
 */
export interface InstalledTheme {
  id: string;
  name: string;
  author: string;
  version: string;
  description: string;
  mode: 'dark' | 'light';
  tags?: string[];
  /** The `[data-theme='<id>']` block — the only CSS, already CI-validated. */
  css: string;
  installedAt: number;
  /**
   * Absolute on-disk directory of this theme (`<appDataDir>/themes/<id>`) when
   * it ships local assets, used to rewrite `url("assets/…")` at inject time.
   * Absent for the vast majority of themes, which have no assets. Repaired at
   * startup if the profile directory moved (see `healThemeAssetBases`).
   */
  assetBase?: string;
  /** Theme-relative asset paths written to disk (e.g. `assets/logo.svg`), for
   *  uninstall and update cleanup. Absent when the theme has no assets. */
  assets?: string[];
  /**
   * Dev `--theme-watch` only: the watched theme's directory on disk, which
   * takes precedence over `assetBase` at inject time so assets resolve out of
   * the author's checkout. Kept separate (and stripped from storage, see
   * partialize) so watching a store-installed theme cannot overwrite the
   * persisted `assetBase` pointing at its installed copy.
   */
  devAssetBase?: string;
  /**
   * Session-only copy pushed by the dev `--theme-watch` sweep. Never written
   * to storage (see partialize/merge below), so a dev session leaves no trace
   * in the user's installed themes.
   */
  dev?: boolean;
}

interface InstalledThemesState {
  themes: InstalledTheme[];
  /** Insert or replace by id (used for both install and update). */
  install: (theme: InstalledTheme) => void;
  uninstall: (id: string) => void;
  isInstalled: (id: string) => boolean;
  getInstalled: (id: string) => InstalledTheme | undefined;
}

export const useInstalledThemesStore = create<InstalledThemesState>()(
  persist(
    (set, get) => ({
      themes: [],
      install: (theme) =>
        set((s) => ({
          // Replace in place so an update (or a dev theme-watch push) keeps
          // the theme's position in the grid; append only when it's new.
          themes: s.themes.some((t) => t.id === theme.id)
            ? s.themes.map((t) => (t.id === theme.id ? theme : t))
            : [...s.themes, theme],
        })),
      uninstall: (id) =>
        set((s) => ({ themes: s.themes.filter((t) => t.id !== id) })),
      isInstalled: (id) => get().themes.some((t) => t.id === id),
      getInstalled: (id) => get().themes.find((t) => t.id === id),
    }),
    {
      name: 'psysonic_installed_themes',
      version: 1,
      // Dev theme-watch copies are session-only: partialize keeps them out of
      // storage, and merge keeps the in-memory ones across a rehydrate (the
      // cross-window storage sync rehydrates on every write from the other
      // window — without this, a persisted change would wipe them).
      // A watched *store-installed* theme is persisted (it is not a dev copy),
      // so its dev-only asset base is stripped on the way out and restored on
      // the way back in — the stored entry keeps pointing at its installed
      // copy either way.
      partialize: (s) => ({
        themes: s.themes
          .filter((t) => !t.dev)
          .map(({ devAssetBase: _devAssetBase, ...t }) => t),
      }),
      merge: (persisted, current) => {
        const stored = (persisted as { themes?: InstalledTheme[] } | undefined)?.themes ?? [];
        const dev = current.themes.filter(
          (t) => t.dev && !stored.some((p) => p.id === t.id),
        );
        const rehydrated = stored.map((t) => {
          const live = current.themes.find((c) => c.id === t.id)?.devAssetBase;
          return live ? { ...t, devAssetBase: live } : t;
        });
        return { ...current, themes: [...rehydrated, ...dev] };
      },
    }
  )
);
