import { fetchThemeAssetBytes, type RegistryTheme } from '@/lib/themes/themeRegistry';
import { ASSET_CAPS, isAllowedAssetPath, svgContentProblems } from '@/lib/themes/themeAssets';
import { writeThemeAssets, type ThemeAssetEntry } from '@/lib/themes/themeAssetStorage';

/** `invalid` = the asset list violates the contract; `error` = a fetch/write failed. */
export type AssetInstallResult =
  | { ok: true; assetBase: string; rels: string[] }
  | { ok: false; reason: 'invalid' | 'error' };

type RegistryAsset = NonNullable<RegistryTheme['assets']>[number];

/** Strip the `themes/<id>/` prefix to the theme-relative path (`assets/…`). */
function toRel(id: string, repoPath: string): string | null {
  const prefix = `themes/${id}/`;
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : null;
}

/** Enforce the contract on the declared list *before* fetching anything. */
function validateRegistryAssets(id: string, assets: RegistryAsset[]): string[] | null {
  if (assets.length > ASSET_CAPS.maxFiles) return null;
  let total = 0;
  const rels: string[] = [];
  for (const a of assets) {
    const rel = toRel(id, a.path);
    if (rel == null || !isAllowedAssetPath(rel)) return null;
    if (typeof a.bytes !== 'number' || a.bytes < 0 || a.bytes > ASSET_CAPS.perFileBytes) return null;
    total += a.bytes;
    rels.push(rel);
  }
  if (total > ASSET_CAPS.perThemeBytes) return null;
  return rels;
}

/**
 * Validate, fetch and write a registry theme's local assets. Returns the
 * absolute base directory to store as the theme's `assetBase`, plus the written
 * theme-relative paths. Fails closed: a contract violation is `invalid`, a
 * network/write failure is `error`, and either way the caller removes the
 * partially-written directory so no half-installed theme survives.
 */
export async function installRegistryAssets(
  id: string,
  assets: RegistryAsset[],
): Promise<AssetInstallResult> {
  const rels = validateRegistryAssets(id, assets);
  if (rels == null) return { ok: false, reason: 'invalid' };

  try {
    const entries: ThemeAssetEntry[] = [];
    for (let i = 0; i < assets.length; i++) {
      const bytes = await fetchThemeAssetBytes(assets[i].path);
      // A lying registry size can't get past the per-file cap.
      if (bytes.byteLength > ASSET_CAPS.perFileBytes) return { ok: false, reason: 'invalid' };
      // SVGs are the one asset type that can carry active/exfiltrating content;
      // sideloaded and store themes alike are checked at write time.
      if (/\.svg$/i.test(rels[i])) {
        const text = new TextDecoder().decode(bytes);
        if (svgContentProblems(text).length > 0) return { ok: false, reason: 'invalid' };
      }
      entries.push({ rel: rels[i], bytes });
    }
    const assetBase = await writeThemeAssets(id, entries);
    return { ok: true, assetBase, rels };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/** One asset provided by the zip import: a theme-relative path and its bytes. */
export interface LocalAssetInput {
  rel: string;
  bytes: Uint8Array;
}

/**
 * Validate and write assets that came from a local zip import (bytes already in
 * hand, no fetch). Every `assets/…` path the CSS references must be present;
 * each provided file must pass the same contract as a store asset (path
 * containment, extension, caps, SVG content). Only referenced assets are
 * written — an unreferenced file in the zip is dropped, not stored. Fails closed;
 * the caller removes the directory on `invalid`.
 */
export async function installLocalAssets(
  id: string,
  cssRefs: string[],
  provided: LocalAssetInput[],
): Promise<AssetInstallResult> {
  const byRel = new Map(provided.map((a) => [a.rel, a]));
  const refs = [...new Set(cssRefs)];

  if (refs.length > ASSET_CAPS.maxFiles) return { ok: false, reason: 'invalid' };
  let total = 0;
  const entries: ThemeAssetEntry[] = [];
  for (const rel of refs) {
    if (!isAllowedAssetPath(rel)) return { ok: false, reason: 'invalid' };
    const a = byRel.get(rel);
    if (!a) return { ok: false, reason: 'invalid' }; // referenced but not in the zip
    if (a.bytes.byteLength > ASSET_CAPS.perFileBytes) return { ok: false, reason: 'invalid' };
    total += a.bytes.byteLength;
    if (total > ASSET_CAPS.perThemeBytes) return { ok: false, reason: 'invalid' };
    if (/\.svg$/i.test(rel)) {
      const text = new TextDecoder().decode(a.bytes);
      if (svgContentProblems(text).length > 0) return { ok: false, reason: 'invalid' };
    }
    entries.push({ rel, bytes: a.bytes });
  }

  try {
    const assetBase = await writeThemeAssets(id, entries);
    return { ok: true, assetBase, rels: refs };
  } catch {
    return { ok: false, reason: 'error' };
  }
}
