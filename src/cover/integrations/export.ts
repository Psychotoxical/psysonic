import { ensureCoverTierJs } from '../resolveJs';
import { resolveCoverDisplayTier } from '../tiers';
import type { CoverArtRef } from '../types';

/** Canvas/export helper — resolves tier from CSS px then returns a Blob. */
export async function loadCoverBlobForExport(
  ref: CoverArtRef,
  displayCssPx: number,
  signal?: AbortSignal,
): Promise<Blob | null> {
  const tier = resolveCoverDisplayTier(displayCssPx, { surface: 'sparse' });
  return ensureCoverTierJs(ref, tier, signal);
}
