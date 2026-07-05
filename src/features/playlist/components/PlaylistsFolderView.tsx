import React from 'react';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { EMPTY_SERVER_FOLDERS, usePlaylistFolderStore } from '@/features/playlist/store/playlistFolderStore';
import { groupPlaylistsByFolder } from '@/features/playlist/utils/playlistFolders';
import { useDragDrop } from '@/lib/dnd/DragDropContext';
import PlaylistFolderSection from '@/features/playlist/components/PlaylistFolderSection';

interface Props {
  serverId: string;
  playlists: SubsonicPlaylist[];
  renderCard: (pl: SubsonicPlaylist) => React.ReactNode;
  disableVirtualization: boolean;
}

/**
 * Playlists page rendered as collapsible folder sections + an ungrouped
 * remainder. Each section reuses `VirtualCardGrid`, so the card layout and
 * virtualisation match the flat grid; only the grouping differs. Rendered only
 * when at least one folder exists (the page falls back to the plain grid).
 */
export default function PlaylistsFolderView({ serverId, playlists, renderCard, disableVirtualization }: Props) {
  const bucket = usePlaylistFolderStore(s => s.byServer[serverId]) ?? EMPTY_SERVER_FOLDERS;
  const { isDragging } = useDragDrop();
  const grouped = groupPlaylistsByFolder(playlists, bucket.folders, bucket.assignments);
  // Keep the ungrouped section as a drop target during a drag even when empty,
  // so a playlist filed into a folder can always be dragged back out to root.
  const showUngrouped = grouped.ungrouped.length > 0 || isDragging;

  return (
    <div className="playlist-folder-view">
      {grouped.folders.map(({ folder, playlists: items }) => (
        <PlaylistFolderSection
          key={folder.id}
          serverId={serverId}
          folder={folder}
          items={items}
          renderCard={renderCard}
          disableVirtualization={disableVirtualization}
        />
      ))}
      {showUngrouped && (
        <PlaylistFolderSection
          serverId={serverId}
          folder={null}
          items={grouped.ungrouped}
          renderCard={renderCard}
          disableVirtualization={disableVirtualization}
        />
      )}
    </div>
  );
}
