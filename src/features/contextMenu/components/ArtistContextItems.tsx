import { useTranslation } from 'react-i18next';
import { Radio, Heart, ChevronRight, ListMusic, Star, Share2 } from 'lucide-react';
import { star, unstar } from '@/lib/api/subsonicStarRating';
import type { SubsonicArtist } from '@/lib/api/subsonicTypes';
import StarRating from '@/ui/StarRating';
import { ArtistToPlaylistSubmenu } from '@/features/contextMenu/components/AlbumArtistToPlaylistSubmenu';
import { MultiArtistToPlaylistSubmenu } from '@/features/contextMenu/components/MultiArtistToPlaylistSubmenu';
import type { ContextMenuItemsProps } from '@/features/contextMenu/components/contextMenuItemTypes';

export default function ArtistContextItems(props: ContextMenuItemsProps) {
  const {
    type, item, shareKindOverride, closeContextMenu,
    setStarredOverride, userRatingOverrides, setKeyboardRating, keyboardRating,
    playlistSubmenuOpen, setPlaylistSubmenuOpen, cancelPlaylistSubmenuCloseTimer, onPlaylistSubmenuTriggerMouseLeave,
    playlistSongIds, setPlaylistSongIds,
    entityRatingSupport, applyArtistRating,
    handleAction, startRadio, copyShareLink, isStarred,
    offlinePolicy,
  } = props;
  const { t } = useTranslation();

  return (
    <>
        {type === 'artist' && (() => {
          const artist = item as SubsonicArtist;
          const artistRatingDisabled = entityRatingSupport === 'track_only';
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => startRadio(artist.id, artist.name))}>
                <Radio size={14} /> {t('contextMenu.startRadio')}
              </div>
              {offlinePolicy.canAddToPlaylist && (
                <div
                  className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `artist:${artist.id}` ? 'active' : ''}`}
                  data-playlist-trigger-id={`artist:${artist.id}`}
                  onMouseEnter={() => { cancelPlaylistSubmenuCloseTimer(); setPlaylistSongIds([`artist:${artist.id}`]); setPlaylistSubmenuOpen(true); }}
                  onMouseLeave={onPlaylistSubmenuTriggerMouseLeave}
                >
                  <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                  <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                  {playlistSubmenuOpen && playlistSongIds[0] === `artist:${artist.id}` && (
                    <ArtistToPlaylistSubmenu artistId={artist.id} triggerId={`artist:${artist.id}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                  )}
                </div>
              )}
              <div className="context-menu-item" onClick={() => handleAction(() => copyShareLink(shareKindOverride ?? 'artist', artist.id))}>
                <Share2 size={14} /> {t('contextMenu.shareLink')}
              </div>
              {(offlinePolicy.canFavorite || offlinePolicy.canRate) && (
                <>
                  <div className="context-menu-divider" />
                  {offlinePolicy.canFavorite && (
                    <div className="context-menu-item" onClick={() => handleAction(() => {
                      const starred = isStarred(artist.id, artist.starred);
                      setStarredOverride(artist.id, !starred);
                      const meta = {
                        serverId: artist.serverId,
                        name: artist.name,
                        albumCount: artist.albumCount,
                      };
                      return starred
                        ? unstar(artist.id, 'artist', meta)
                        : star(artist.id, 'artist', meta);
                    })}>
                      <Heart size={14} fill={isStarred(artist.id, artist.starred) ? 'currentColor' : 'none'} />
                      {isStarred(artist.id, artist.starred) ? t('contextMenu.unfavoriteArtist') : t('contextMenu.favoriteArtist')}
                    </div>
                  )}
                  {offlinePolicy.canRate && (
                    <div
                      className="context-menu-rating-row"
                      data-rating-kind="artist"
                      data-rating-id={artist.id}
                      data-rating-disabled={artistRatingDisabled ? 'true' : 'false'}
                      onClick={e => e.stopPropagation()}
                    >
                      <Star size={14} className="context-menu-rating-icon" aria-hidden />
                      <StarRating
                        value={keyboardRating?.kind === 'artist' && keyboardRating.id === artist.id
                          ? keyboardRating.value
                          : userRatingOverrides[artist.id] ?? artist.userRating ?? 0}
                        disabled={artistRatingDisabled}
                        labelKey="entityRating.artistAriaLabel"
                        onChange={r => { setKeyboardRating({ kind: 'artist', id: artist.id, value: r }); applyArtistRating(artist, r); }}
                      />
                    </div>
                  )}
                </>
              )}
            </>
          );
        })()}

        {type === 'multi-artist' && (() => {
          const artists = item as SubsonicArtist[];
          const artistIds = artists.map(a => a.id);
          const artistRatingDisabled = entityRatingSupport === 'track_only';
          const multiArtistRatingId = [...artistIds].sort().join('\x1e');
          const unifiedArtistRating = (() => {
            if (artists.length === 0) return 0;
            const vals = artists.map(a => userRatingOverrides[a.id] ?? a.userRating ?? 0);
            const first = vals[0];
            return vals.every(v => v === first) ? first : 0;
          })();
          return (
            <>
              <div className="context-menu-header" style={{ padding: '8px 12px', fontSize: 13, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                {t('contextMenu.selectedArtists', { count: artists.length })}
              </div>
              <div className="context-menu-divider" />
              {offlinePolicy.canAddToPlaylist && (
                <div
                  className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === `multi-artist:${artistIds.join(',')}` ? 'active' : ''}`}
                  data-playlist-trigger-id={`multi-artist:${artistIds.join(',')}`}
                  onMouseEnter={() => { cancelPlaylistSubmenuCloseTimer(); setPlaylistSongIds([`multi-artist:${artistIds.join(',')}`]); setPlaylistSubmenuOpen(true); }}
                  onMouseLeave={onPlaylistSubmenuTriggerMouseLeave}
                >
                  <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                  <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                  {playlistSubmenuOpen && playlistSongIds[0] === `multi-artist:${artistIds.join(',')}` && (
                    <MultiArtistToPlaylistSubmenu artistIds={artistIds} triggerId={`multi-artist:${artistIds.join(',')}`} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                  )}
                </div>
              )}
              {offlinePolicy.canRate && (
                <div
                  className="context-menu-rating-row"
                  data-rating-kind="artist"
                  data-rating-id={multiArtistRatingId}
                  data-rating-disabled={artistRatingDisabled ? 'true' : 'false'}
                  onClick={e => e.stopPropagation()}
                >
                  <Star size={14} className="context-menu-rating-icon" aria-hidden />
                  <StarRating
                    value={
                      keyboardRating?.kind === 'artist' && keyboardRating.id === multiArtistRatingId
                        ? keyboardRating.value
                        : unifiedArtistRating
                    }
                    disabled={artistRatingDisabled}
                    ariaLabel={t('entityRating.selectedArtistsRatingAriaLabel', { count: artists.length })}
                    onChange={r => {
                      setKeyboardRating({ kind: 'artist', id: multiArtistRatingId, value: r });
                      for (const a of artists) applyArtistRating(a, r);
                    }}
                  />
                </div>
              )}
            </>
          );
        })()}

    </>
  );
}
