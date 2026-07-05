import { useTranslation } from 'react-i18next';
import { Play, Radio, Heart, ChevronRight, User, Disc3, ListMusic, Info, Sparkles, Star, Trash2, Share2 } from 'lucide-react';
import { queueSongStar } from '@/features/playback/store/pendingStarSync';
import { getMusicNetworkRuntime, useEnrichmentPrimary } from '@/music-network';
import type { Track } from '@/lib/media/trackTypes';
import { useAuthStore } from '@/store/authStore';
import { renderPresetIcon } from '@/music-network';
import StarRating from '@/ui/StarRating';
import { AddToPlaylistSubmenu } from '@/features/contextMenu/components/AddToPlaylistSubmenu';
import type { ContextMenuItemsProps } from '@/features/contextMenu/components/contextMenuItemTypes';

export default function QueueItemContextItems(props: ContextMenuItemsProps) {
  const {
    type, item, queueIndex,
    playTrack, removeTrack, closeContextMenu,
    networkLovedCache, setNetworkLovedForSong,
    openSongInfo, userRatingOverrides, setKeyboardRating, keyboardRating,
    playlistSubmenuOpen, setPlaylistSubmenuOpen, cancelPlaylistSubmenuCloseTimer, onPlaylistSubmenuTriggerMouseLeave,
    playlistSongIds, setPlaylistSongIds,
    audiomuseNavidromeEnabled,
    applySongRating,
    handleAction, startRadio, startInstantMix, copyShareLink, isStarred,
    navigateLibrary,
  } = props;
  const { t } = useTranslation();
  const auth = useAuthStore();
  const networkPrimary = useEnrichmentPrimary();
  const networkLabel = networkPrimary?.label ?? '';
  const networkIcon = networkPrimary?.icon ?? 'custom';

  return (
    <>
        {type === 'queue-item' && (() => {
          const song = item as Track;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => playTrack(song, undefined, undefined, undefined, queueIndex))}>
                <Play size={14} /> {t('contextMenu.playNow')}
              </div>
              <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(() => {
                if (queueIndex !== undefined) removeTrack(queueIndex);
              })}>
                <Trash2 size={14} /> {t('contextMenu.removeFromQueue')}
              </div>
              <div
                className={`context-menu-item context-menu-item--submenu ${playlistSubmenuOpen && playlistSongIds[0] === song.id ? 'active' : ''}`}
                data-playlist-trigger-id={song.id}
                onMouseEnter={() => { cancelPlaylistSubmenuCloseTimer(); setPlaylistSongIds([song.id]); setPlaylistSubmenuOpen(true); }}
                onMouseLeave={onPlaylistSubmenuTriggerMouseLeave}
              >
                <ListMusic size={14} /> {t('contextMenu.addToPlaylist')}
                <ChevronRight size={13} style={{ marginLeft: 'auto' }} />
                {playlistSubmenuOpen && playlistSongIds[0] === song.id && (
                  <AddToPlaylistSubmenu songIds={[song.id]} triggerId={song.id} onDone={() => { setPlaylistSubmenuOpen(false); closeContextMenu(); }} />
                )}
              </div>
              <div className="context-menu-divider" />
              {song.albumId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigateLibrary(`/album/${song.albumId}`))}>
                  <Disc3 size={14} /> {t('contextMenu.openAlbum')}
                </div>
              )}
              {song.artistId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigateLibrary(`/artist/${song.artistId}`))}>
                  <User size={14} /> {t('contextMenu.goToArtist')}
                </div>
              )}
              <div className="context-menu-item" onClick={() => handleAction(() => startRadio(song.artistId ?? song.artist, song.artist, song))}>
                <Radio size={14} /> {t('contextMenu.startRadio')}
              </div>
              {audiomuseNavidromeEnabled && (
                <div className="context-menu-item" onClick={() => handleAction(() => startInstantMix(song))}>
                  <Sparkles size={14} /> {t('contextMenu.instantMix')}
                </div>
              )}
              <div className="context-menu-item" onClick={() => handleAction(() => {
                queueSongStar(song.id, !isStarred(song.id, song.starred), song.serverId);
              })}>
                <Heart size={14} fill={isStarred(song.id, song.starred) ? 'currentColor' : 'none'} />
                {isStarred(song.id, song.starred) ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
              </div>
              {auth.enrichmentPrimaryId !== null && (() => {
                const loveKey = `${song.title}::${song.artist}`;
                const loved = networkLovedCache[loveKey] ?? false;
                return (
                  <div className="context-menu-item" onClick={() => handleAction(() => {
                    const newLoved = !loved;
                    setNetworkLovedForSong(song.title, song.artist, newLoved);
                    void getMusicNetworkRuntime().setTrackLoved({ title: song.title, artist: song.artist }, newLoved);
                  })}>
                    {renderPresetIcon(networkIcon, 14)}
                    {loved ? t('contextMenu.networkUnlove', { provider: networkLabel }) : t('contextMenu.networkLove', { provider: networkLabel })}
                  </div>
                );
              })()}
              <div
                className="context-menu-rating-row"
                data-rating-kind="song"
                data-rating-id={song.id}
                data-rating-disabled="false"
                onClick={e => e.stopPropagation()}
              >
                <Star size={14} className="context-menu-rating-icon" aria-hidden />
                <StarRating
                  value={keyboardRating?.kind === 'song' && keyboardRating.id === song.id
                    ? keyboardRating.value
                    : userRatingOverrides[song.id] ?? song.userRating ?? 0}
                  onChange={r => { setKeyboardRating({ kind: 'song', id: song.id, value: r }); applySongRating(song.id, r); }}
                  ariaLabel={t('albumDetail.ratingLabel')}
                />
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => copyShareLink('track', song.id))}>
                <Share2 size={14} /> {t('contextMenu.shareLink')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => openSongInfo(song.id))}>
                <Info size={14} /> {t('contextMenu.songInfo')}
              </div>
            </>
          );
        })()}
    </>
  );
}
