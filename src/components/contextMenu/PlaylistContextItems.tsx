import { useTranslation } from 'react-i18next';
import { Play, ChevronRight, ListMusic, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { SubsonicPlaylist } from '../../api/subsonicTypes';
import { useAuthStore } from '../../store/authStore';
import { usePlaylistStore } from '../../store/playlistStore';
import { MultiPlaylistToPlaylistSubmenu, SinglePlaylistToPlaylistSubmenu } from './PlaylistToPlaylistSubmenus';
import type { ContextMenuItemsProps } from './contextMenuItemTypes';

export default function PlaylistContextItems(props: ContextMenuItemsProps) {
  const {
    type, item, queueIndex, playlistId, playlistSongIndex, shareKindOverride,
    playTrack, playNext, enqueue, removeTrack, queue, currentTrack, closeContextMenu,
    starredOverrides, setStarredOverride, lastfmLovedCache, setLastfmLovedForSong,
    openSongInfo, userRatingOverrides, setKeyboardRating, keyboardRating,
    playlistSubmenuOpen, setPlaylistSubmenuOpen, playlistSongIds, setPlaylistSongIds,
    orbitRole, entityRatingSupport, audiomuseNavidromeEnabled,
    applySongRating, applyAlbumRating, applyArtistRating,
    handleAction, startRadio, startInstantMix, downloadAlbum, copyShareLink, isStarred,
  } = props;
  const { t } = useTranslation();
  const auth = useAuthStore();
  const navigate = useNavigate();

  return (
    <>
        {type === 'playlist' && (() => {
          const playlist = item as SubsonicPlaylist;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/playlists/${playlist.id}`))}>
                <Play size={14} /> {t('contextMenu.playNow')}
              </div>
              <div className="context-menu-divider" />
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `playlist:${playlist.id}` ? 'active' : ''}`}
                data-playlist-trigger-id={`playlist:${playlist.id}`}
                onMouseEnter={() => { setPlaylistSongIds([`playlist:${playlist.id}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `playlist:${playlist.id}` && (
                  <SinglePlaylistToPlaylistSubmenu playlist={playlist} triggerId={`playlist:${playlist.id}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(async () => {
                const { showToast } = await import('../../utils/toast');
                const { deletePlaylist } = await import('../../api/subsonicPlaylists');
                const { removeId } = usePlaylistStore.getState();
                try {
                  await deletePlaylist(playlist.id);
                  removeId(playlist.id);
                  // Update local playlist state without page reload to preserve audio playback state
                  usePlaylistStore.setState((s) => ({
                    playlists: s.playlists.filter((p) => p.id !== playlist.id),
                  }));
                  showToast(t('playlists.deleteSuccess', { count: 1 }), 3000, 'info');
                } catch {
                  showToast(t('playlists.deleteFailed', { name: playlist.name }), 3000, 'error');
                }
              })}>
                <Trash2 size={14} /> {t('playlists.deletePlaylist')}
              </div>
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
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `multi-playlist:${playlistIds.join(',')}` ? 'active' : ''}`}
                data-playlist-trigger-id={`multi-playlist:${playlistIds.join(',')}`}
                onMouseEnter={() => { setPlaylistSongIds([`multi-playlist:${playlistIds.join(',')}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `multi-playlist:${playlistIds.join(',')}` && (
                  <MultiPlaylistToPlaylistSubmenu playlists={selectedPlaylists} triggerId={`multi-playlist:${playlistIds.join(',')}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(async () => {
                const { showToast } = await import('../../utils/toast');
                const { deletePlaylist } = await import('../../api/subsonicPlaylists');
                const { removeId } = usePlaylistStore.getState();
                const deletedIds: string[] = [];
                for (const pl of selectedPlaylists) {
                  try {
                    await deletePlaylist(pl.id);
                    removeId(pl.id);
                    deletedIds.push(pl.id);
                  } catch {
                    showToast(t('playlists.deleteFailed', { name: pl.name }), 3000, 'error');
                  }
                }
                if (deletedIds.length > 0) {
                  // Update local playlist state without page reload to preserve audio playback state
                  usePlaylistStore.setState((s) => ({
                    playlists: s.playlists.filter((p) => !deletedIds.includes(p.id)),
                  }));
                  showToast(t('playlists.deleteSuccess', { count: deletedIds.length }), 3000, 'info');
                }
              })}>
                <Trash2 size={14} /> {t('playlists.deleteSelected')}
              </div>
            </>
          );
        })()}

    </>
  );
}
