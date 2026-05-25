import { getDiskSrc, rememberDiskSrc } from './diskSrcCache';
import { hasCoverDiskReadyListeners, notifyCoverDiskReady } from './diskHandoff';
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

/** Seed lookup-order tier keys (512 + 800 fallback path, etc.) — no subscriber wakeups. */
export function seedGridDiskSrcCache(
  scope: CoverServerScope,
  coverArtId: CoverArtId,
  wantTier: CoverArtTier,
  fsPath: string,
): boolean {
  if (!fsPath) return false;
  let hit = false;
  for (const tier of gridDiskSrcLookupOrder(wantTier)) {
    if (rememberDiskSrc(coverStorageKey(scope, coverArtId, tier), fsPath)) hit = true;
  }
  return hit;
}

/**
 * After peek/ensure: seed cache and wake mounted cells once (avoids 4× notify / re-render storms).
 */
export function rememberGridDiskSrc(
  scope: CoverServerScope,
  coverArtId: CoverArtId,
  wantTier: CoverArtTier,
  fsPath: string,
): boolean {
  const hit = seedGridDiskSrcCache(scope, coverArtId, wantTier, fsPath);
  if (!hit) return false;
  const wantKey = coverStorageKey(scope, coverArtId, wantTier);
  if (hasCoverDiskReadyListeners(wantKey)) {
    notifyCoverDiskReady(wantKey, fsPath);
  }
  return true;
}
