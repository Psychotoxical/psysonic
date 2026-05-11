import { getCurrentWindow } from '@tauri-apps/api/window';

export type WindowKind = 'main' | 'mini';

let cached: WindowKind | null = null;

/**
 * Tauri window-label detection, cached after the first call. The result
 * decides whether App() renders the full main UI tree or the standalone
 * mini-player tree, and it must be consistent for the lifetime of the
 * webview — Tauri never changes a window's label.
 *
 * Falls back to 'main' in non-Tauri environments (jsdom, plain browser).
 */
export function getWindowKind(): WindowKind {
  if (cached !== null) return cached;
  let label: string;
  try {
    label = getCurrentWindow().label;
  } catch {
    label = 'main';
  }
  cached = label === 'mini' ? 'mini' : 'main';
  return cached;
}

/** Test-only: clears the cached window kind so each test starts clean. */
export function _resetWindowKindCacheForTest(): void {
  cached = null;
}
