import { FIXED_THEMES } from '@/lib/themes/fixedThemes';

/**
 * Slim-bundle theme migration (C5). Older builds bundled ~80 palettes that now
 * live only in the community Theme Store. A persisted active / scheduler theme
 * may therefore reference an id that is neither bundled (`FIXED_THEMES`) nor
 * installed — it would resolve to no `[data-theme]` block and render as an
 * unstyled `:root`.
 *
 * This runs synchronously in `runPreReactBootstrap` *before* React mounts,
 * rewriting the persisted selection in localStorage so the store hydrates
 * already-correct (no flash of the wrong/blank theme — Zustand rehydrate runs
 * after first paint, so we read/write the persisted JSON directly, matching the
 * other pre-React bootstrap steps).
 *
 * By design we do **not** auto-install anything from the store: an unresolved
 * id simply falls back to a bundled theme — Mocha (dark) for the main + night
 * slots, Latte (light) for the day slot. The fallback is always bundled, so the
 * migration never needs the network and works offline.
 */

const THEME_KEY = 'psysonic_theme';
const INSTALLED_KEY = 'psysonic_installed_themes';
/** Set when the migration reset a theme, so the app can show a one-time notice. */
const NOTICE_KEY = 'psysonic_theme_migration_notice';
const FALLBACK_DARK = 'mocha';
const FALLBACK_LIGHT = 'latte';

const FIXED_IDS = new Set(FIXED_THEMES.map((t) => t.id));

/** Per-slot fallback: main + night are dark (Mocha), the day slot is light (Latte). */
const SLOT_FALLBACK = {
  theme: FALLBACK_DARK,
  themeDay: FALLBACK_LIGHT,
  themeNight: FALLBACK_DARK,
} as const;

/** Ids of themes the user has installed from the store (persisted CSS lives here). */
function installedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(INSTALLED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as { state?: { themes?: Array<{ id?: unknown }> } };
    const ids = (parsed.state?.themes ?? [])
      .map((t) => t.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

export function migrateThemeSelection(): void {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (!raw) return; // fresh profile — defaults are bundled themes already
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    const state = parsed.state;
    if (!state || typeof state !== 'object') return;

    const installed = installedIds();
    const isResolved = (id: unknown): boolean =>
      typeof id === 'string' && (FIXED_IDS.has(id) || installed.has(id));

    let changed = false;
    const resetIds: string[] = [];
    for (const slot of ['theme', 'themeDay', 'themeNight'] as const) {
      const current = state[slot];
      if (typeof current === 'string' && current.length > 0 && !isResolved(current)) {
        resetIds.push(current);
        state[slot] = SLOT_FALLBACK[slot];
        changed = true;
      }
    }

    if (changed) {
      localStorage.setItem(THEME_KEY, JSON.stringify(parsed));
      // Record what was reset so the app can show a one-time, dismissible notice.
      const unique = [...new Set(resetIds)];
      if (unique.length) localStorage.setItem(NOTICE_KEY, JSON.stringify(unique));
    }
  } catch {
    // Malformed storage or non-browser runtime — non-fatal; the store falls back
    // to its own bundled defaults on hydrate.
  }
}

/** Ids of themes the migration reset (for the one-time notice); [] if none. */
export function readThemeMigrationNotice(): string[] {
  try {
    const raw = localStorage.getItem(NOTICE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Dismiss the one-time migration notice. */
export function clearThemeMigrationNotice(): void {
  try {
    localStorage.removeItem(NOTICE_KEY);
  } catch {
    // ignore
  }
}
