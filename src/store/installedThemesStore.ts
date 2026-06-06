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
        set((s) => ({ themes: [...s.themes.filter((t) => t.id !== theme.id), theme] })),
      uninstall: (id) =>
        set((s) => ({ themes: s.themes.filter((t) => t.id !== id) })),
      isInstalled: (id) => get().themes.some((t) => t.id === id),
      getInstalled: (id) => get().themes.find((t) => t.id === id),
    }),
    {
      name: 'psysonic_installed_themes',
      version: 1,
    }
  )
);
