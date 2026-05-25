import type { CoverArtRef, CoverArtTier } from './types';

/** Phase A stub — full resolve in wave 1A */
export async function ensureCoverTierJs(
  _ref: CoverArtRef,
  _tier: CoverArtTier,
  _signal?: AbortSignal,
  _getPriority?: () => number,
): Promise<Blob | null> {
  return null;
}
