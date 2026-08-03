/**
 * Picks the theme shown in the store's spotlight slot.
 *
 * The catalogue is sorted newest-changed-first, so a theme that has not been
 * touched in a while sits several pages down and is effectively invisible: it is
 * only ever reached by someone who deliberately pages to the end. The spotlight
 * exists to surface exactly those, which is why the pick is drawn from *behind*
 * the first page rather than uniformly across the whole registry.
 *
 * Preferences degrade instead of failing, so a small catalogue (or one the user
 * has installed most of) still shows something rather than an empty slot.
 */

import type { RegistryTheme } from '@/lib/themes/themeRegistry';
import { themeRequiresNewerApp } from '@/lib/themes/themeRegistry';
import { compareThemesByNewest } from '@/lib/themes/themeCatalogSort';

export interface SpotlightPickInput {
  /** The full registry catalogue, in any order. */
  themes: RegistryTheme[];
  /** Ids of themes already installed locally. */
  installedIds: ReadonlySet<string>;
  /** Id of the theme currently applied, if any. */
  activeThemeId?: string | null;
  /**
   * Id to avoid picking again — the theme the spotlight is showing right now, so
   * "show another" actually lands on another one. Honoured only while some other
   * candidate remains; on a one-theme catalogue the same theme is still returned
   * rather than blanking the slot.
   */
  excludeId?: string | null;
  /**
   * How many themes the store lists on its first page. Everything ranked at or
   * beyond this is "past the fold" and counts as undiscovered.
   */
  frontPageSize: number;
  /** Random value in [0, 1). Passed in so the pick is deterministic in tests. */
  random: number;
}

/**
 * Returns the theme to spotlight, or `null` when there is nothing sensible to
 * show (empty catalogue, or every entry is unusable on this build).
 */
export function pickSpotlightTheme(input: SpotlightPickInput): RegistryTheme | null {
  const { themes, installedIds, activeThemeId, excludeId, frontPageSize, random } = input;
  if (themes.length === 0) return null;

  const ranked = [...themes].sort(compareThemesByNewest);

  // Recommending the theme that is already applied is noise, and one that needs
  // a newer app can't be installed from here — neither belongs in the slot.
  const usable = ranked.filter(th => th.id !== activeThemeId && !themeRequiresNewerApp(th));
  // Dropping the current pick is a preference, not a requirement: with a single
  // usable theme, showing it again beats showing nothing.
  const withoutCurrent = usable.filter(th => th.id !== excludeId);
  const eligible = withoutCurrent.length > 0 ? withoutCurrent : usable;
  if (eligible.length === 0) return null;

  const pastFold = (th: RegistryTheme) => ranked.indexOf(th) >= frontPageSize;
  const notInstalled = (th: RegistryTheme) => !installedIds.has(th.id);

  // Best to worst: undiscovered and new to the user, then merely undiscovered,
  // then anything the user has not installed, then anything at all.
  const pools = [
    eligible.filter(th => pastFold(th) && notInstalled(th)),
    eligible.filter(pastFold),
    eligible.filter(notInstalled),
    eligible,
  ];
  const pool = pools.find(p => p.length > 0) ?? eligible;

  // Clamp defensively: a caller handing over exactly 1 (or a hair under, from a
  // seeded generator) must not index past the end.
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random * pool.length)));
  return pool[index];
}
