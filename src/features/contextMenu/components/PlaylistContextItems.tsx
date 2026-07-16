import { useTranslation } from 'react-i18next';
import { Play, ChevronsRight, ChevronRight, FolderTree, ListMusic, ListPlus, Trash2 } from 'lucide-react';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { usePlaylistStore, resolvePlaylistTracks } from '@/features/playlist';
import { MultiPlaylistToPlaylistSubmenu, SinglePlaylistToPlaylistSubmenu } from '@/features/contextMenu/components/PlaylistToPlaylistSubmenus';
import MoveToFolderSubmenu from '@/features/contextMenu/components/MoveToFolderSubmenu';
import type { ContextMenuItemsProps } from '@/features/contextMenu/components/contextMenuItemTypes';

export default function PlaylistContextItems(props: ContextMenuItemsProps) {
  const {
    type, item, closeContextMenu,
    playTrack, playNext, enqueue,
    playlistSubmenuOpen, setPlaylistSubmenuOpen, cancelPlaylistSubmenuCloseTimer, onPlaylistSubmenuTriggerMouseLeave,
    playlistSongIds, setPlaylistSongIds,
    handleAction,
    offlinePolicy,
  } = props;
  const { t } = useTranslation();

  return (
    <>
        {type === 'playlist' && (() => {
          const playlist = item as SubsonicPlaylist;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(async () => {
                const tracks = await resolvePlaylistTracks(playlist.id, playlist.serverId);
                if (tracks.length === 0) return;
                playTrack(tracks[0], tracks);
              })}>
                <Play size={14} /> {t('contextMenu.playNow')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(async () => {
                const tracks = await resolvePlaylistTracks(playlist.id, playlist.serverId);
                if (tracks.length === 0) return;
                playNext(tracks);
              })}>
                <ChevronsRight size={14} /> {t('contextMenu.playNext')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(async () => {
                const tracks = await resolvePlaylistTracks(playlist.id, playlist.serverId);
                if (tracks.length === 0) return;
                enqueue(tracks);
              })}>
                <ListPlus size={14} /> {t('contextMenu.addToQueue')}
              </div>
              <div className="context-menu-divider" />
              {offlinePolicy.canAddToPlaylist && (
                <div
                  className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `playlist:${playlist.id}` ? 'active' : ''}`}
                  data-playlist-trigger-id={`playlist:${playlist.id}`}
                  onMouseEnter={() => { cancelPlaylistSubmenuCloseTimer(); setPlaylistSongIds([`playlist:${playlist.id}`]); setPlaylistSubmenuOpen(true); }}
                  onMouseLeave={onPlaylistSubmenuTriggerMouseLeave}
                >
                  <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                  <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                  {playlistSubmenuOpen && playlistSongIds[0] === `playlist:${playlist.id}` && (
                    <SinglePlaylistToPlaylistSubmenu playlist={playlist} triggerId={`playlist:${playlist.id}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                  )}
                </div>
              )}
              {/* Folder assignment is local-only state, so it stays available offline. */}
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `folder:${playlist.id}` ? 'active' : ''}`}
                data-playlist-trigger-id={`folder:${playlist.id}`}
                onMouseEnter={() => { cancelPlaylistSubmenuCloseTimer(); setPlaylistSongIds([`folder:${playlist.id}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={onPlaylistSubmenuTriggerMouseLeave}
              >
                <FolderTree size={14} /> {t('playlists.folders.moveToFolder')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `folder:${playlist.id}` && (
                  <MoveToFolderSubmenu playlistId={playlist.id} serverId={playlist.serverId} triggerId={`folder:${playlist.id}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              {offlinePolicy.canEditPlaylist && (
                <>
              <div className="context-menu-divider" />
              <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(async () => {
                const { showToast } = await import('@/lib/dom/toast');
                const { deletePlaylistForServer } = await import('@/lib/api/subsonicPlaylists');
                const { removeId } = usePlaylistStore.getState();
                try {
                  if (!playlist.serverId) throw new Error('Playlist owner unavailable');
                  await deletePlaylistForServer(playlist.serverId, playlist.id);
                  removeId(playlist.id, playlist.serverId);
                  // Update local playlist state without page reload to preserve audio playback state
                  usePlaylistStore.setState((s) => ({
                    playlists: s.playlists.filter((p) => p.id !== playlist.id || p.serverId !== playlist.serverId),
                  }));
                  showToast(t('playlists.deleteSuccess', { count: 1 }), 3000, 'info');
                } catch {
                  showToast(t('playlists.deleteFailed', { name: playlist.name }), 3000, 'error');
                }
              })}>
                <Trash2 size={14} /> {t('playlists.deletePlaylist')}
              </div>
                </>
              )}
            </>
          );
        })()}

        {type === 'multi-playlist' && (() => {
          const selectedPlaylists = item as SubsonicPlaylist[];
          const playlistIds = selectedPlaylists.map(p => p.id);
          return (
            <>
              <div className="context-menu-header" style={{ padding: '8px 12px', fontSize: 13, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                {t('contextMenu.selectedPlaylists', { count: selectedPlaylists.length })}
              </div>
              <div className="context-menu-divider" />
              {offlinePolicy.canAddToPlaylist && (
                <div
                  className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `multi-playlist:${playlistIds.join(',')}` ? 'active' : ''}`}
                  data-playlist-trigger-id={`multi-playlist:${playlistIds.join(',')}`}
                  onMouseEnter={() => { cancelPlaylistSubmenuCloseTimer(); setPlaylistSongIds([`multi-playlist:${playlistIds.join(',')}`]); setPlaylistSubmenuOpen(true); }}
                  onMouseLeave={onPlaylistSubmenuTriggerMouseLeave}
                >
                  <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                  <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                  {playlistSubmenuOpen && playlistSongIds[0] === `multi-playlist:${playlistIds.join(',')}` && (
                    <MultiPlaylistToPlaylistSubmenu playlists={selectedPlaylists} triggerId={`multi-playlist:${playlistIds.join(',')}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                  )}
                </div>
              )}
              {offlinePolicy.canEditPlaylist && (
              <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(async () => {
                const { showToast } = await import('@/lib/dom/toast');
                const { deletePlaylistForServer } = await import('@/lib/api/subsonicPlaylists');
                const { removeId } = usePlaylistStore.getState();
                const deletedIds = new Set<string>();
                for (const pl of selectedPlaylists) {
                  try {
                    if (!pl.serverId) throw new Error('Playlist owner unavailable');
                    await deletePlaylistForServer(pl.serverId, pl.id);
                    removeId(pl.id, pl.serverId);
                    deletedIds.add(`${pl.serverId}:${pl.id}`);
                  } catch {
                    showToast(t('playlists.deleteFailed', { name: pl.name }), 3000, 'error');
                  }
                }
                if (deletedIds.size > 0) {
                  // Update local playlist state without page reload to preserve audio playback state
                  usePlaylistStore.setState((s) => ({
                    playlists: s.playlists.filter((p) => !deletedIds.has(`${p.serverId ?? ''}:${p.id}`)),
                  }));
                  showToast(t('playlists.deleteSuccess', { count: deletedIds.size }), 3000, 'info');
                }
              })}>
                <Trash2 size={14} /> {t('playlists.deleteSelected')}
              </div>
              )}
            </>
          );
        })()}

    </>
  );
}
