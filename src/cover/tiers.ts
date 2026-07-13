import { COVER_ART_DENSE_MAX_TIER, COVER_ART_TIERS, type CoverArtTier, type CoverSurfaceKind } from './types';

export { COVER_ART_TIERS, COVER_ART_DENSE_MAX_TIER };

/** Smallest WebP tier Rust writes (`cover_cache::DERIVE_TIERS`). */
export const COVER_ART_MIN_DERIVED_TIER = 128 as const;

export function resolveCoverDisplayTier(
  displayCssPx: number,
  opts?: { dpr?: number; fullRes?: boolean; surface?: CoverSurfaceKind },
): CoverArtTier {
  if (opts?.fullRes) return 2000;
  const dpr = opts?.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1);
  const neededPx = Math.ceil(displayCssPx * dpr);
  let tier = COVER_ART_TIERS.find(t => t !== 2000 && t >= neededPx) ?? 800;
  if (tier < COVER_ART_MIN_DERIVED_TIER) tier = COVER_ART_MIN_DERIVED_TIER;
  if (opts?.surface === 'dense' && tier > COVER_ART_DENSE_MAX_TIER) {
    tier = COVER_ART_DENSE_MAX_TIER;
  }
  return tier;
}
