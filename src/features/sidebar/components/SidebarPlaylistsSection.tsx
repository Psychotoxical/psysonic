import React from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, PlayCircle, Sparkles } from 'lucide-react';
import { displayPlaylistName, isSmartPlaylistName } from '@/features/sidebar/utils/sidebarHelpers';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { usePlaylistStore } from '@/features/playlist';
import { EMPTY_SERVER_FOLDERS, usePlaylistFolderStore } from '@/features/playlist';
import { groupPlaylistsByFolder } from '@/features/playlist';

interface SidebarPlaylist {
  id: string;
  name: string;
}

interface Props {
  playlists: SidebarPlaylist[];
  playlistsLoading: boolean;
}

/**
 * Sidebar playlist list, grouped into collapsible folders when the active
 * server has any. Folder state comes from the shared local folder store;
 * creation / rename / deletion lives on the Playlists page, while assignment
 * works here via each playlist's right-click menu ("Move to folder"). With no
 * folders this renders the original flat list (plus right-click support).
 */
export default function SidebarPlaylistsSection({ playlists, playlistsLoading }: Props) {
  const { t } = useTranslation();
  const serverId = useAuthStore(s => s.activeServerId);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const fullPlaylists = usePlaylistStore(s => s.playlists);
  const bucket =
    usePlaylistFolderStore(s => (serverId ? s.byServer[serverId] : undefined)) ?? EMPTY_SERVER_FOLDERS;
  const toggleFolderCollapsed = usePlaylistFolderStore(s => s.toggleFolderCollapsed);

  if (playlistsLoading) {
    return (
      <div className="sidebar-playlists-list">
        <div className="sidebar-playlists-loading">
          <div className="spinner" style={{ width: 14, height: 14 }} />
        </div>
      </div>
    );
  }
  if (playlists.length === 0) {
    return (
      <div className="sidebar-playlists-list">
        <div className="sidebar-playlists-empty">{t('playlists.empty')}</div>
      </div>
    );
  }

  const renderItem = (pl: SidebarPlaylist) => (
    <NavLink
      key={pl.id}
      to={`/playlists/${pl.id}`}
      className={({ isActive }) => `nav-link sidebar-playlist-item ${isActive ? 'active' : ''}`}
      onContextMenu={e => {
        e.preventDefault();
        const full = fullPlaylists.find(p => p.id === pl.id) ?? pl;
        openContextMenu(e.clientX, e.clientY, full, 'playlist');
      }}
    >
      {isSmartPlaylistName(pl.name) ? <Sparkles size={12} /> : <PlayCircle size={12} />}
      <span>{displayPlaylistName(pl.name)}</span>
    </NavLink>
  );

  if (!serverId || bucket.folders.length === 0) {
    return <div className="sidebar-playlists-list">{playlists.map(renderItem)}</div>;
  }

  const grouped = groupPlaylistsByFolder(playlists, bucket.folders, bucket.assignments);

  return (
    <div className="sidebar-playlists-list">
      {grouped.folders.map(({ folder, playlists: items }) => (
        <div key={folder.id} className="sidebar-playlist-folder">
          <button
            className={`sidebar-playlist-folder-header${folder.collapsed ? '' : ' expanded'}`}
            onClick={() => toggleFolderCollapsed(serverId, folder.id)}
            aria-expanded={!folder.collapsed}
            aria-label={folder.collapsed ? t('playlists.folders.expandFolder') : t('playlists.folders.collapseFolder')}
          >
            <ChevronRight size={12} className="sidebar-playlist-folder-chevron" />
            <Folder size={12} />
            <span className="sidebar-playlist-folder-name">{folder.name}</span>
            <span className="sidebar-playlist-folder-count">{items.length}</span>
          </button>
          {!folder.collapsed && items.length > 0 && (
            <div className="sidebar-playlist-folder-items">{items.map(renderItem)}</div>
          )}
        </div>
      ))}
      {grouped.ungrouped.map(renderItem)}
    </div>
  );
}
