import { getDiskSrc } from './diskSrcCache';
import { coverStorageKey } from './storageKeys';
import type { CoverArtId, CoverArtTier, CoverServerScope } from './types';

/** Dense grids: prefer a larger on-disk tier (800) before tiny thumbs when the ideal tier is missing. */
export function gridDiskSrcLookupOrder(want: CoverArtTier): CoverArtTier[] {
  const out: CoverArtTier[] = [want];
  if (want >= 256 && want < 800) out.push(800);
  const ladder: CoverArtTier[] = [128, 256, 512, 800];
  for (let i = ladder.length - 1; i >= 0; i -= 1) {
    const t = ladder[i]!;
    if (t !== want && t < want && !out.includes(t)) out.push(t);
  }
  if (want < 800 && !out.includes(800)) out.push(800);
  return out;
}

/** Synchronous hit from `diskSrcCache` — any tier already warmed/peeked for this cover. */
export function getDiskSrcForGrid(
  scope: CoverServerScope,
  coverArtId: CoverArtId,
  wantTier: CoverArtTier,
): string {
  for (const tier of gridDiskSrcLookupOrder(wantTier)) {
    const src = getDiskSrc(coverStorageKey(scope, coverArtId, tier));
    if (src) return src;
  }
  return '';
}
