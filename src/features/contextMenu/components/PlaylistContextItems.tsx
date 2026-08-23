import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Play, ChevronsRight, ChevronRight, FolderTree, ListMusic, ListPlus, Sparkles, Trash2 } from 'lucide-react';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import {
  deleteOwnedPlaylist,
  playlistsOpenSmartEditorState,
  resolvePlaylistTracks,
  usePlaylistStore,
} from '@/features/playlist';
import { isSmartPlaylist } from '@/lib/format/playlistClassification';
import { MultiPlaylistToPlaylistSubmenu, SinglePlaylistToPlaylistSubmenu } from '@/features/contextMenu/components/PlaylistToPlaylistSubmenus';
import MoveToFolderSubmenu from '@/features/contextMenu/components/MoveToFolderSubmenu';
import type { ContextMenuItemsProps } from '@/features/contextMenu/components/contextMenuItemTypes';
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';

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
  const navigate = useNavigate();

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
              {playlist.serverId && <div
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
              </div>}
              {offlinePolicy.canEditPlaylist && isSmartPlaylist(playlist) && (
                <div className="context-menu-item" onClick={() => handleAction(() => {
                  const dest = playlistsOpenSmartEditorState(playlist);
                  if (dest) navigate(dest.pathname, { state: dest.state });
                })}>
                  <Sparkles size={14} /> {t('playlists.editRules')}
                </div>
              )}
              {offlinePolicy.canEditPlaylist && (
                <>
              <div className="context-menu-divider" />
              <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(async () => {
                const { showToast } = await import('@/lib/dom/toast');
                const { removeId } = usePlaylistStore.getState();
                try {
                  if (!playlist.serverId) throw new Error('Playlist owner unavailable');
                  await deleteOwnedPlaylist(playlist);
                  removeId(playlist.id, playlist.serverId);
                  // Update local playlist state without page reload to preserve audio playback state
                  usePlaylistStore.setState((s) => ({
                    playlists: s.playlists.filter((p) => ownedEntityKey(p) !== ownedEntityKey(playlist)),
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
          const playlistIds = selectedPlaylists.map(ownedEntityKey);
          const selectedServerIds = new Set(selectedPlaylists.map(pl => pl.serverId).filter(Boolean));
          const oneServerSelection = selectedServerIds.size === 1
            && selectedPlaylists.every(pl => Boolean(pl.serverId));
          return (
            <>
              <div className="context-menu-header" style={{ padding: '8px 12px', fontSize: 13, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                {t('contextMenu.selectedPlaylists', { count: selectedPlaylists.length })}
              </div>
              <div className="context-menu-divider" />
              {offlinePolicy.canAddToPlaylist && oneServerSelection && (
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
                const { removeId } = usePlaylistStore.getState();
                const deletedKeys = new Set<string>();
                for (const pl of selectedPlaylists) {
                  try {
                    if (!pl.serverId) throw new Error('Playlist owner unavailable');
                    await deleteOwnedPlaylist(pl);
                    removeId(pl.id, pl.serverId);
                    deletedKeys.add(ownedEntityKey(pl));
                  } catch {
                    showToast(t('playlists.deleteFailed', { name: pl.name }), 3000, 'error');
                  }
                }
                if (deletedKeys.size > 0) {
                  // Update local playlist state without page reload to preserve audio playback state
                  usePlaylistStore.setState((s) => ({
                    playlists: s.playlists.filter((p) => !deletedKeys.has(ownedEntityKey(p))),
                  }));
                  showToast(t('playlists.deleteSuccess', { count: deletedKeys.size }), 3000, 'info');
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
