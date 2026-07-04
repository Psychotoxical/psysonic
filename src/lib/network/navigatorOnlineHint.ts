import { isTauri } from '@tauri-apps/api/core';

/**
 * Whether callers should treat `navigator.onLine === false` as an offline signal.
 *
 * Returns `true` only in non-Tauri hosts when `navigator.onLine` is false.
 * WebKitGTK inside Tauri often leaves `navigator.onLine === false` even when
 * HTTP to the user's Subsonic/Navidrome server works (ping, search, playback).
 * Desktop builds must not trust that hint — use Subsonic probes instead.
 *
 * @see https://github.com/orgs/tauri-apps/discussions/9269
 */
export function isNavigatorOfflineHint(): boolean {
  if (typeof navigator === 'undefined') return false;
  try {
    if (isTauri()) return false;
  } catch {
    /* isTauri unavailable in some test harnesses — fall through */
  }
  return !navigator.onLine;
}
