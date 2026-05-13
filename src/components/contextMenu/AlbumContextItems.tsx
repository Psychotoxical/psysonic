import { useTranslation } from 'react-i18next';
import { Play, ListPlus, Heart, Download, ChevronRight, ChevronsRight, User, ListMusic, Star, Share2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getAlbum } from '../../api/subsonicLibrary';
import { star, unstar } from '../../api/subsonicStarRating';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import { useAuthStore } from '../../store/authStore';
import { songToTrack } from '../../utils/songToTrack';
import StarRating from '../StarRating';
import { AlbumToPlaylistSubmenu } from './AlbumArtistToPlaylistSubmenu';
import { MultiAlbumToPlaylistSubmenu } from './MultiAlbumToPlaylistSubmenu';
import type { ContextMenuItemsProps } from './contextMenuItemTypes';

export default function AlbumContextItems(props: ContextMenuItemsProps) {
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
        {type === 'album' && (() => {
          const album = item as SubsonicAlbum;
          const albumRatingDisabled = entityRatingSupport === 'track_only';
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/album/${album.id}`))}>
                <Play size={14} /> {t('contextMenu.openAlbum')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(async () => {
                const albumData = await getAlbum(album.id);
                const tracks = albumData.songs.map(songToTrack);
                if (tracks.length === 0) return;
                playNext(tracks);
              })}>
                <ChevronsRight size={14} /> {t('contextMenu.playNext')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(async () => {
                const albumData = await getAlbum(album.id);
                enqueue(albumData.songs.map(songToTrack));
              })}>
                <ListPlus size={14} /> {t('contextMenu.enqueueAlbum')}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => navigate(`/artist/${album.artistId}`))}>
                <User size={14} /> {t('contextMenu.goToArtist')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => {
                const starred = isStarred(album.id, album.starred);
                setStarredOverride(album.id, !starred);
                return starred ? unstar(album.id, 'album') : star(album.id, 'album');
              })}>
                <Heart size={14} fill={isStarred(album.id, album.starred) ? 'currentColor' : 'none'} />
                {isStarred(album.id, album.starred) ? t('contextMenu.unfavoriteAlbum') : t('contextMenu.favoriteAlbum')}
              </div>
              <div
                className="context-menu-rating-row"
                data-rating-kind="album"
                data-rating-id={album.id}
                data-rating-disabled={albumRatingDisabled ? 'true' : 'false'}
                onClick={e => e.stopPropagation()}
              >
                <Star size={14} className="context-menu-rating-icon" aria-hidden />
                <StarRating
                  value={keyboardRating?.kind === 'album' && keyboardRating.id === album.id
                    ? keyboardRating.value
                    : userRatingOverrides[album.id] ?? album.userRating ?? 0}
                  disabled={albumRatingDisabled}
                  labelKey="entityRating.albumAriaLabel"
                  onChange={r => { setKeyboardRating({ kind: 'album', id: album.id, value: r }); applyAlbumRating(album, r); }}
                />
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => copyShareLink('album', album.id))}>
                <Share2 size={14} /> {t('contextMenu.shareLink')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => downloadAlbum(album.name, album.id))}>
                <Download size={14} /> {t('contextMenu.download')}
              </div>
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `album:${album.id}` ? 'active' : ''}`}
                data-playlist-trigger-id={`album:${album.id}`}
                onMouseEnter={() => { setPlaylistSongIds([`album:${album.id}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `album:${album.id}` && (
                  <AlbumToPlaylistSubmenu albumId={album.id} triggerId={`album:${album.id}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
            </>
          );
        })()}

        {type === 'multi-album' && (() => {
          const albums = item as SubsonicAlbum[];
          const albumIds = albums.map(a => a.id);
          const albumRatingDisabled = entityRatingSupport === 'track_only';
          const multiAlbumRatingId = [...albumIds].sort().join('\x1e');
          const unifiedAlbumRating = (() => {
            if (albums.length === 0) return 0;
            const vals = albums.map(a => userRatingOverrides[a.id] ?? a.userRating ?? 0);
            const first = vals[0];
            return vals.every(v => v === first) ? first : 0;
          })();
          return (
            <>
              <div className="context-menu-header" style={{ padding: '8px 12px', fontSize: 13, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                {t('contextMenu.selectedAlbums', { count: albums.length })}
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(async () => {
                // Parallel — Navidrome handles concurrent getAlbum requests fine.
                const results = await Promise.all(albums.map(a => getAlbum(a.id)));
                const allTracks = results.flatMap(r => r.songs.map(songToTrack));
                enqueue(allTracks);
              })}>
                <ListPlus size={14} /> {t('contextMenu.enqueueAlbums', { count: albums.length })}
              </div>
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `multi-album:${albumIds.join(',')}` ? 'active' : ''}`}
                data-playlist-trigger-id={`multi-album:${albumIds.join(',')}`}
                onMouseEnter={() => { setPlaylistSongIds([`multi-album:${albumIds.join(',')}`]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={() => setPlaylistSubmenuOpen(false)}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === `multi-album:${albumIds.join(',')}` && (
                  <MultiAlbumToPlaylistSubmenu albumIds={albumIds} triggerId={`multi-album:${albumIds.join(',')}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div
                className="context-menu-rating-row"
                data-rating-kind="album"
                data-rating-id={multiAlbumRatingId}
                data-rating-disabled={albumRatingDisabled ? 'true' : 'false'}
                onClick={e => e.stopPropagation()}
              >
                <Star size={14} className="context-menu-rating-icon" aria-hidden />
                <StarRating
                  value={
                    keyboardRating?.kind === 'album' && keyboardRating.id === multiAlbumRatingId
                      ? keyboardRating.value
                      : unifiedAlbumRating
                  }
                  disabled={albumRatingDisabled}
                  ariaLabel={t('entityRating.selectedAlbumsRatingAriaLabel', { count: albums.length })}
                  onChange={r => {
                    setKeyboardRating({ kind: 'album', id: multiAlbumRatingId, value: r });
                    for (const a of albums) applyAlbumRating(a, r);
                  }}
                />
              </div>
            </>
          );
        })()}

    </>
  );
}
