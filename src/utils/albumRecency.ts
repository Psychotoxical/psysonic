const NEW_ALBUM_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

export function isAlbumRecentlyAdded(created?: string): boolean {
  if (!created) return false;
  const createdMs = Date.parse(created);
  if (!Number.isFinite(createdMs)) return false;
  return Date.now() - createdMs <= NEW_ALBUM_WINDOW_MS;
}
