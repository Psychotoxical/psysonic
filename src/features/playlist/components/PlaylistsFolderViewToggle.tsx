import React from 'react';
import { useTranslation } from 'react-i18next';
import { FolderTree } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { usePlaylistFolderStore } from '@/features/playlist/store/playlistFolderStore';

/**
 * Header toggle to switch the Playlists page between the grouped folder view
 * and a single flat grid. Hidden until the active server has at least one
 * folder (nothing to switch otherwise).
 */
export default function PlaylistsFolderViewToggle() {
  const { t } = useTranslation();
  const activeServerId = useAuthStore(s => s.activeServerId);
  const folderCount = usePlaylistFolderStore(
    s => (activeServerId ? s.byServer[activeServerId]?.folders.length ?? 0 : 0),
  );
  const groupView = usePlaylistFolderStore(s => s.groupView);
  const toggleGroupView = usePlaylistFolderStore(s => s.toggleGroupView);

  if (folderCount === 0) return null;

  return (
    <button
      className={`btn btn-surface${groupView ? ' btn-sort-active' : ''}`}
      onClick={toggleGroupView}
      aria-pressed={groupView}
      data-tooltip={t('playlists.folders.groupByFolders')}
      data-tooltip-pos="bottom"
      style={groupView ? { background: 'var(--accent)', color: 'var(--text-on-accent)' } : {}}
    >
      <FolderTree size={15} /> {t('playlists.folders.groupByFolders')}
    </button>
  );
}
