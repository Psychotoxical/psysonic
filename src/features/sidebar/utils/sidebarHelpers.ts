export const SIDEBAR_NAV_LONG_PRESS_MS = 1000;
export const SIDEBAR_NAV_LONG_PRESS_MOVE_CANCEL_PX = 10;
export const NEW_RELEASES_UNREAD_STORAGE_PREFIX = 'psy_new_releases_unread_seen_v2';
export const NEW_RELEASES_UNREAD_SAMPLE_SIZE = 80;
export const NEW_RELEASES_UNREAD_POLL_MS = 2 * 60 * 1000;
export const NEW_RELEASES_RESET_DELAY_MS = 5_000;
/** Max album ids persisted per selected-library scope; cap keeps the newest batch. */
export const NEW_RELEASES_SEEN_MAX_IDS = 500;

export function newReleasesSeenStorageKey(scopeFingerprint: string): string {
  return `${NEW_RELEASES_UNREAD_STORAGE_PREFIX}:${scopeFingerprint || 'empty'}`;
}

/** Merge previous seen IDs with the current local chronological sample. */
export function mergeSeenNewReleaseIdsCap(prevSeen: string[], newestBatch: string[], maxIds: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of newestBatch) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of prevSeen) {
    if (out.length >= maxIds) break;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function isPointerOutsideAsideSidebar(clientX: number, clientY: number): boolean {
  const aside = document.querySelector('aside.sidebar');
  if (!aside) return false;
  const r = aside.getBoundingClientRect();
  return clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom;
}
