export const SIDEBAR_NAV_LONG_PRESS_MS = 1000;
export const SIDEBAR_NAV_LONG_PRESS_MOVE_CANCEL_PX = 10;
export const SMART_PREFIX = 'psy-smart-';
export const NEW_RELEASES_UNREAD_STORAGE_PREFIX = 'psy_new_releases_unread_seen_v1';
export const NEW_RELEASES_UNREAD_SAMPLE_SIZE = 80;
export const NEW_RELEASES_UNREAD_POLL_MS = 2 * 60 * 1000;
export const NEW_RELEASES_RESET_DELAY_MS = 5_000;
/** Max album ids persisted per server/scope; cap must not drop the latest "newest" batch when marking read. */
export const NEW_RELEASES_SEEN_MAX_IDS = 500;

/** Merge previous seen IDs with the current `getAlbumList(newest)` sample: newest batch is kept in full first, then older seen until `maxIds` (localStorage budget). */
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

export function isSmartPlaylistName(name: string): boolean {
  return (name ?? '').toLowerCase().startsWith(SMART_PREFIX);
}

export function displayPlaylistName(name: string): string {
  const n = name ?? '';
  if (isSmartPlaylistName(n)) return n.slice(SMART_PREFIX.length);
  return n;
}

export function isPointerOutsideAsideSidebar(clientX: number, clientY: number): boolean {
  const aside = document.querySelector('aside.sidebar');
  if (!aside) return false;
  const r = aside.getBoundingClientRect();
  return clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom;
}
