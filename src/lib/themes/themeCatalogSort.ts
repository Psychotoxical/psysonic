/**
 * Ordering helpers for the Theme Store catalogue. Kept in one place so every
 * surface that ranks the registry — the store list, the spotlight pick — walks
 * the catalogue in the same order.
 */

import type { RegistryTheme } from '@/lib/themes/themeRegistry';

/** Alphabetical by display name. Also the stable tie-breaker for every other
 *  ordering, so themes sharing a timestamp never shuffle between renders. */
export function compareThemesByName(a: RegistryTheme, b: RegistryTheme): number {
  return a.name.localeCompare(b.name);
}

/** Most recently changed first. Themes with no `updatedAt` sort last. */
export function compareThemesByNewest(a: RegistryTheme, b: RegistryTheme): number {
  return (b.updatedAt || '').localeCompare(a.updatedAt || '') || compareThemesByName(a, b);
}
