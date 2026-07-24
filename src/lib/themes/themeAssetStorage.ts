import { BaseDirectory, mkdir, writeFile, remove, readDir, exists } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { isTauri } from '@tauri-apps/api/core';

/**
 * On-disk storage for a theme's local assets, under
 * `<appDataDir>/themes/<id>/…`. That directory is inside the asset-protocol
 * scope (`$APPDATA/**`), so `convertFileSrc` can serve the files to the webview
 * — the same mechanism the cover cache uses. One directory per theme keeps
 * uninstall and the orphan sweep trivial.
 */

const THEMES_DIR = 'themes';

/** One asset to write: a theme-relative path (`assets/x.svg`) and its bytes. */
export interface ThemeAssetEntry {
  rel: string;
  bytes: Uint8Array;
}

/** Absolute on-disk directory for a theme — the base for the inject-time rewrite. */
export async function themeAssetBaseDir(id: string): Promise<string> {
  return join(await appDataDir(), THEMES_DIR, id);
}

/**
 * Write a theme's assets, replacing any prior set. Removes the theme's directory
 * first so files dropped by a new version don't linger, then writes each entry
 * (creating parent directories). Returns the absolute base directory to store as
 * the theme's `assetBase`. Throws on failure so the caller can fail the install.
 */
export async function writeThemeAssets(id: string, entries: ThemeAssetEntry[]): Promise<string> {
  await removeThemeAssets(id);
  for (const e of entries) {
    const rel = `${THEMES_DIR}/${id}/${e.rel}`;
    const slash = rel.lastIndexOf('/');
    await mkdir(rel.slice(0, slash), { baseDir: BaseDirectory.AppData, recursive: true });
    await writeFile(rel, e.bytes, { baseDir: BaseDirectory.AppData });
  }
  return themeAssetBaseDir(id);
}

/** Delete a theme's on-disk directory. Best-effort — a missing directory is fine. */
export async function removeThemeAssets(id: string): Promise<void> {
  if (!isTauri()) return;
  const dir = `${THEMES_DIR}/${id}`;
  try {
    if (await exists(dir, { baseDir: BaseDirectory.AppData })) {
      await remove(dir, { baseDir: BaseDirectory.AppData, recursive: true });
    }
  } catch {
    // best-effort: a leftover directory is caught by the orphan sweep
  }
}

/**
 * Remove theme directories with no matching installed theme. Covers a crash
 * mid-install and themes removed by an older client that didn't clean up. Runs
 * once at startup; best-effort.
 */
export async function sweepOrphanThemeDirs(keepIds: Set<string>): Promise<void> {
  if (!isTauri()) return;
  try {
    if (!(await exists(THEMES_DIR, { baseDir: BaseDirectory.AppData }))) return;
    const entries = await readDir(THEMES_DIR, { baseDir: BaseDirectory.AppData });
    for (const ent of entries) {
      if (ent.isDirectory && !keepIds.has(ent.name)) {
        await remove(`${THEMES_DIR}/${ent.name}`, { baseDir: BaseDirectory.AppData, recursive: true });
      }
    }
  } catch {
    // best-effort
  }
}
