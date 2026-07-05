/**
 * Pure route-path predicates for the single-entity detail routes. These are
 * domain-agnostic URL checks (no store/feature state), so they live in
 * `lib/navigation` where both feature browse logic and lower-layer navigation
 * helpers (`albumDetailNavigation`) can consume them without an inversion.
 */

/** True when pathname is a single album detail route (`/album/:id`). */
export function isAlbumDetailPath(pathname: string): boolean {
  return /^\/album\/[^/]+\/?$/.test(pathname.split('?')[0]?.replace(/\/$/, '') || pathname);
}

/** True when pathname is a single artist detail route (`/artist/:id`). */
export function isArtistDetailPath(pathname: string): boolean {
  return /^\/artist\/[^/]+\/?$/.test(pathname);
}

/** True when pathname is a single composer detail route (`/composer/:id`). */
export function isComposerDetailPath(pathname: string): boolean {
  return /^\/composer\/[^/]+\/?$/.test(pathname);
}
