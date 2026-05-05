/**
 * Every literal `coverArtCacheKey(_, size)` width used across the UI.
 * Used for IndexedDB sibling lookup, invalidateCoverArt, and the static test guard.
 *
 * When adding a new cover size anywhere in `src/**`, bump this tuple and rerun tests.
 */
export const COVER_ART_REGISTERED_SIZES = [
  40, 48, 64, 80, 96, 128, 200, 256, 300, 400, 500, 600, 800, 2000,
] as const;
