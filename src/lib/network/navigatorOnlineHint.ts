import { isTauri } from '@tauri-apps/api/core';

/**
 * Whether the host reports the browser as offline via `navigator.onLine`.
 *
 * WebKitGTK inside Tauri often leaves `navigator.onLine === false` even when
 * HTTP to the user's Subsonic/Navidrome server works (ping, search, playback).
 * Desktop builds must not treat that as offline — use Subsonic probes instead.
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
