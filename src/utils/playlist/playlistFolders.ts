/**
 * Playlist folders — a local, client-side organisation layer over the server's
 * flat playlist list. The Subsonic API has no folder concept, so folders and
 * their playlist assignments live only in Psysonic (see `playlistFolderStore`),
 * scoped per server. This module holds the shared types and the pure grouping
 * function used by every surface that renders folders (sidebar, Playlists page).
 */

export interface PlaylistFolder {
  id: string;
  name: string;
  /** Stable sort order among folders (assigned at creation). */
  order: number;
  collapsed: boolean;
}

export interface PlaylistFolderGroup<T> {
  folder: PlaylistFolder;
  playlists: T[];
}

export interface GroupedPlaylists<T> {
  /** Folders in display order; each carries its playlists (possibly empty). */
  folders: PlaylistFolderGroup<T>[];
  /** Playlists not assigned to any (existing) folder, in input order. */
  ungrouped: T[];
}

/**
 * Split `playlists` into folder groups + an ungrouped remainder.
 *
 * Folders are returned in `order` (then name) order and always appear, even
 * when empty, so a freshly created folder is visible. Playlists keep their
 * incoming order within each bucket — callers sort the input upstream. An
 * assignment pointing at a folder that no longer exists falls back to ungrouped.
 */
export function groupPlaylistsByFolder<T extends { id: string }>(
  playlists: readonly T[],
  folders: readonly PlaylistFolder[],
  assignments: Readonly<Record<string, string>>,
): GroupedPlaylists<T> {
  const orderedFolders = [...folders].sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name),
  );
  const byFolder = new Map<string, T[]>();
  for (const folder of orderedFolders) byFolder.set(folder.id, []);

  const ungrouped: T[] = [];
  for (const playlist of playlists) {
    const folderId = assignments[playlist.id];
    const bucket = folderId != null ? byFolder.get(folderId) : undefined;
    if (bucket) bucket.push(playlist);
    else ungrouped.push(playlist);
  }

  return {
    folders: orderedFolders.map(folder => ({
      folder,
      playlists: byFolder.get(folder.id) ?? [],
    })),
    ungrouped,
  };
}

/** Next stable `order` value for a new folder appended to `folders`. */
export function nextFolderOrder(folders: readonly PlaylistFolder[]): number {
  return folders.reduce((max, f) => Math.max(max, f.order + 1), 0);
}
