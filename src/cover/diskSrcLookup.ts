import { getDiskSrc, rememberDiskSrc } from './diskSrcCache';
import { hasCoverDiskReadyListeners, notifyCoverDiskReady } from './diskHandoff';
import { coverStorageKeyFromRef } from './storageKeys';
import type { CoverArtRef, CoverArtTier } from './types';

/** Tier embedded in a cover file path (`…/512.webp`, `…/2000-fanart.webp`). */
function coverPathTier(fsPath: string): number | null {
  const m = /(\d+)(?:-[a-z0-9]+)?\.webp$/i.exec(fsPath);
  return m ? Number(m[1]) : null;
}

/**
 * Rust paths arrive as `path|mtimeVersion` (ensure results, peek batch values,
 * `cover:tier-ready` payloads). Split once, here, so every seeder remembers the
 * versioned URL: the webview image cache keys on the full URL and must never
 * serve stale bytes for a tier that was overwritten in place.
 */
function splitPathVersion(fsPath: string): { path: string; version: string } {
  const sep = fsPath.lastIndexOf('|');
  if (sep < 0 || !/^\d+$/.test(fsPath.slice(sep + 1))) {
    return { path: fsPath, version: '' };
  }
  return { path: fsPath.slice(0, sep), version: fsPath.slice(sep + 1) };
}

/** Re-join a (possibly version-stripped) path back into the wire format. */
function joinPathVersion(path: string, version: string): string {
  return version ? `${path}|${version}` : path;
}

/**
 * Never seed the full-res (≥2000) key from a smaller tier's file. The grid lookup
 * order intentionally cross-seeds smaller display keys, but pinning a downscaled
 * image under the 2000 key would make Hero / fullscreen / the lightbox show a
 * small cover (they read the 2000 key before running ensure). Mirrors the Rust
 * `peek_plain_cover_tier` exact-only rule for full-res.
 */
function skipFullResSeedTier(tier: CoverArtTier, fsPath: string): boolean {
  if (tier < 2000) return false;
  const src = coverPathTier(splitPathVersion(fsPath).path);
  return src == null || src < 2000;
}

/**
 * Never seed a display (<2000) key from a full-res (≥2000) file — the mirror
 * direction of {@link skipFullResSeedTier}. A tier-2000 file can be the
 * Navidrome vinyl placeholder (the lightbox's full-res download writes it for a
 * coverless album even after an external-chain HIT, because the chain never
 * writes 2000), and a placeholder pinned under `:800` is exactly the
 * single-frame hero flash: the hero renders vinyl, its next re-ensure peeks the
 * real on-disk 800 and reseeds, flipping back. Seeding only the 2000 key keeps
 * the lightbox's full-res behavior intact while display surfaces never see the
 * placeholder.
 */
function isFullResSeedFile(fsPath: string): boolean {
  const src = coverPathTier(splitPathVersion(fsPath).path);
  return src != null && src >= 2000;
}

/** Dense grids: prefer a larger on-disk tier (800) before tiny thumbs when the ideal tier is missing. */
export function gridDiskSrcLookupOrder(want: CoverArtTier): CoverArtTier[] {
  const out: CoverArtTier[] = [want];
  // Rust peek ladder for tier 64 falls back to 128.webp — mirror that in memory lookup.
  if (want === 64 && !out.includes(128)) out.push(128);
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
export function getDiskSrcForGrid(ref: CoverArtRef, wantTier: CoverArtTier): string {
  for (const tier of gridDiskSrcLookupOrder(wantTier)) {
    const src = getDiskSrc(coverStorageKeyFromRef(ref, tier));
    if (src) return src;
  }
  return '';
}

/** Seed lookup-order tier keys (512 + 800 fallback path, etc.) — no subscriber wakeups. */
export function seedGridDiskSrcCache(ref: CoverArtRef, wantTier: CoverArtTier, fsPath: string): boolean {
  if (!fsPath) return false;
  const { path, version } = splitPathVersion(fsPath);
  // A full-res (≥2000) file seeds ONLY its own key (see isFullResSeedFile).
  const fullResFile = isFullResSeedFile(fsPath);
  let hit = false;
  for (const tier of gridDiskSrcLookupOrder(wantTier)) {
    if (fullResFile && tier < 2000) continue;
    if (skipFullResSeedTier(tier, fsPath)) continue;
    if (rememberDiskSrc(coverStorageKeyFromRef(ref, tier), joinPathVersion(path, version))) hit = true;
  }
  return hit;
}

/**
 * After peek/ensure: seed cache and wake mounted cells once (avoids 4× notify / re-render storms).
 */
export function rememberGridDiskSrc(ref: CoverArtRef, wantTier: CoverArtTier, fsPath: string): boolean {
  const hit = seedGridDiskSrcCache(ref, wantTier, fsPath);
  if (!hit) return false;
  const wantKey = coverStorageKeyFromRef(ref, wantTier);
  if (hasCoverDiskReadyListeners(wantKey)) {
    notifyCoverDiskReady(wantKey, fsPath);
  }
  return true;
}

/** Rust `cover:tier-ready` — seed ladder keys so sparse cells see 800.webp when they want 128. */
export function rememberDiskSrcLadder(
  serverIndexKey: string,
  ref: Pick<CoverArtRef, 'cacheKind' | 'cacheEntityId'>,
  wantTier: CoverArtTier,
  fsPath: string,
): boolean {
  if (!serverIndexKey || !ref.cacheEntityId || !fsPath) return false;
  const { path, version } = splitPathVersion(fsPath);
  // A full-res (≥2000) file seeds ONLY its own key (see isFullResSeedFile) —
  // `cover:tier-ready` tier=2000 events must never poison display keys.
  const fullResFile = isFullResSeedFile(fsPath);
  let hit = false;
  for (const tier of gridDiskSrcLookupOrder(wantTier)) {
    if (fullResFile && tier < 2000) continue;
    if (skipFullResSeedTier(tier, fsPath)) continue;
    const key = `${serverIndexKey}:cover:${ref.cacheKind}:${ref.cacheEntityId}:${tier}`;
    if (rememberDiskSrc(key, joinPathVersion(path, version))) hit = true;
  }
  return hit;
}
