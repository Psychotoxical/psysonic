import { useAuthStore } from '../../store/authStore';
import { DEFAULT_ARTIST_SECTIONS, useArtistLayoutStore } from '../../store/artistLayoutStore';
import { DEFAULT_QUEUE_TOOLBAR_BUTTONS, useQueueToolbarStore } from '../../store/queueToolbarStore';
import { DEFAULT_PLAYLIST_LAYOUT_ITEMS, usePlaylistLayoutStore } from '../../store/playlistLayoutStore';

const MIGRATION_FLAG = 'psysonic_advanced_mode_migrated';
const LEGACY_OPEN_KEY = 'psysonic_personalisation_advanced_open';

function arraysEqual<T extends { id: string; visible: boolean }>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].visible !== b[i].visible) return false;
  }
  return true;
}

/**
 * One-time bridge from the v1.46 "Personalisation → Advanced group" (per-tab
 * collapsible) to the global Advanced Mode toggle. Auto-enables the new toggle
 * for users who had previously opened the collapsible OR already customised any
 * of the three sub-sections that now sit behind it. Idempotent via a localStorage
 * flag — runs at most once per install.
 */
export function runAdvancedModeMigration(): void {
  try {
    if (localStorage.getItem(MIGRATION_FLAG) === '1') return;
  } catch {
    return;
  }

  const legacyOpen = (() => {
    try { return localStorage.getItem(LEGACY_OPEN_KEY) === 'true'; } catch { return false; }
  })();
  const artistCustomised = !arraysEqual(
    useArtistLayoutStore.getState().sections,
    DEFAULT_ARTIST_SECTIONS,
  );
  const queueCustomised = !arraysEqual(
    useQueueToolbarStore.getState().buttons,
    DEFAULT_QUEUE_TOOLBAR_BUTTONS,
  );
  const playlistCustomised = !arraysEqual(
    usePlaylistLayoutStore.getState().items,
    DEFAULT_PLAYLIST_LAYOUT_ITEMS,
  );

  if (legacyOpen || artistCustomised || queueCustomised || playlistCustomised) {
    useAuthStore.getState().setAdvancedSettingsEnabled(true);
  }

  try {
    localStorage.removeItem(LEGACY_OPEN_KEY);
    localStorage.setItem(MIGRATION_FLAG, '1');
  } catch {
    // best effort — next boot retries
  }
}
