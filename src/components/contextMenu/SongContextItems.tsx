import { useTranslation } from 'react-i18next';
import { Play, ListPlus, Radio, Heart, ChevronRight, ChevronsRight, User, Disc3, ListMusic, Info, Sparkles, Star, Trash2, HeartCrack, Share2, Orbit as OrbitIcon } from 'lucide-react';
import { useNavigateToAlbum } from '../../hooks/useNavigateToAlbum';
import { useNavigateToArtist } from '../../hooks/useNavigateToArtist';
import { resolveAlbum, resolveMediaServerId, resolvePlaylist } from '../../utils/offline/offlineMediaResolve';
import { queueSongStar } from '../../store/pendingStarSync';
import { getMusicNetworkRuntime, useEnrichmentPrimary } from '../../music-network';
import type { Track } from '../../store/playerStoreTypes';
import { useAuthStore } from '../../store/authStore';
import { usePlaylistStore } from '../../store/playlistStore';
import { songToTrack } from '../../utils/playback/songToTrack';
import { showToast } from '../../utils/ui/toast';
import { suggestOrbitTrack, hostEnqueueToOrbit, evaluateOrbitSuggestGate, OrbitSuggestBlockedError } from '../../utils/orbit';
import { renderPresetIcon } from '../settings/musicNetwork/presetIcon';
import StarRating from '../StarRating';
import { AddToPlaylistSubmenu } from './AddToPlaylistSubmenu';
import type { ContextMenuItemsProps } from './contextMenuItemTypes';

export default function SongContextItems(props: ContextMenuItemsProps) {
  const {
    type, item, playlistId, playlistSongIndex,
    playTrack, playNext, enqueue, closeContextMenu,
    networkLovedCache, setNetworkLovedForSong,
    openSongInfo, userRatingOverrides, setKeyboardRating, keyboardRating,
    playlistSubmenuOpen, setPlaylistSubmenuOpen, cancelPlaylistSubmenuCloseTimer, onPlaylistSubmenuTriggerMouseLeave,
    playlistSongIds, setPlaylistSongIds,
    orbitRole, audiomuseNavidromeEnabled,
    applySongRating,
    handleAction, startRadio, startInstantMix, copyShareLink, isStarred,
    offlinePolicy,
  } = props;
  const { t } = useTranslation();
  const auth = useAuthStore();
  const networkPrimary = useEnrichmentPrimary();
  const networkLabel = networkPrimary?.label ?? '';
  const networkIcon = networkPrimary?.icon ?? 'custom';
  const navigateToAlbum = useNavigateToAlbum();
  const navigateToArtist = useNavigateToArtist();

  return (
    <>
        {(type === 'song' || type === 'album-song') && (() => {
          const song = item as Track;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => playTrack(song, [song]))}>
                <Play size={14} /> {t('contextMenu.playNow')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => playNext([song]))}>
                <ChevronsRight size={14} /> {t('contextMenu.playNext')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => enqueue([song]))}>
                <ListPlus size={14} /> {t('contextMenu.addToQueue')}
              </div>
              {orbitRole === 'guest' && (() => {
                const muted = evaluateOrbitSuggestGate().reason === 'muted';
                return (
                  <div
                    className={`context-menu-item${muted ? ' is-disabled' : ''}`}
                    {...(muted ? { 'data-tooltip': t('orbit.suggestBlockedMuted') } : {})}
                    onClick={() => handleAction(() => {
                      if (muted) { showToast(t('orbit.suggestBlockedMuted'), 3500, 'error'); return; }
                      suggestOrbitTrack(song.id)
                        .then(() => showToast(t('orbit.ctxSuggestedToast'), 2200, 'info'))
                        .catch(err => {
                          if (err instanceof OrbitSuggestBlockedError && err.reason === 'muted') {
                            showToast(t('orbit.suggestBlockedMuted'), 3500, 'error');
                          } else {
                            showToast(t('orbit.ctxSuggestFailed'), 3000, 'error');
                          }
                        });
                    })}
                  >
                    <OrbitIcon size={14} /> {t('orbit.ctxAddToSession')}
                  </div>
                );
              })()}
              {orbitRole === 'host' && (
                <div className="context-menu-item" onClick={() => handleAction(() => {
                  hostEnqueueToOrbit(song.id)
                    .then(() => showToast(t('orbit.ctxAddedHostToast'), 2200, 'info'))
                    .catch(() => showToast(t('orbit.ctxAddHostFailed'), 3000, 'error'));
                })}>
                  <OrbitIcon size={14} /> {t('orbit.ctxAddToSessionHost')}
                </div>
              )}
              {offlinePolicy.canAddToPlaylist && (
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
              )}
             {type === 'album-song' && (
                 <div className="context-menu-item" onClick={() => handleAction(async () => {
                   const serverId = resolveMediaServerId(song.serverId);
                   if (!serverId || !song.albumId) return;
                   const albumData = await resolveAlbum(serverId, song.albumId);
                   if (!albumData) return;
                   const tracks = albumData.songs.map(songToTrack);
                   enqueue(tracks);
                 })}>
                  <ListPlus size={14} /> {t('contextMenu.enqueueAlbum')}
                </div>
              )}
              <div className="context-menu-divider" />
              {song.albumId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigateToAlbum(song.albumId!))}>
                  <Disc3 size={14} /> {t('contextMenu.openAlbum')}
                </div>
              )}
              {song.artistId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigateToArtist(song.artistId!))}>
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
              {offlinePolicy.canFavorite && (
                <div className="context-menu-item" onClick={() => handleAction(() => {
                  queueSongStar(song.id, !isStarred(song.id, song.starred), song.serverId);
                })}>
                  <Heart size={14} fill={isStarred(song.id, song.starred) ? 'currentColor' : 'none'} />
                  {isStarred(song.id, song.starred) ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
                </div>
              )}
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
              {offlinePolicy.canRate && (
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
              )}
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => copyShareLink('track', song.id))}>
                <Share2 size={14} /> {t('contextMenu.shareLink')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => openSongInfo(song.id))}>
                <Info size={14} /> {t('contextMenu.songInfo')}
              </div>
              {offlinePolicy.canEditPlaylist && playlistId && playlistSongIndex !== undefined && (
                <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(async () => {
                  const { updatePlaylist } = await import('../../api/subsonicPlaylists');
                  const { showToast } = await import('../../utils/ui/toast');
                  const touchPlaylist = usePlaylistStore.getState().touchPlaylist;
                  try {
                    const serverId = resolveMediaServerId();
                    if (!serverId) return;
                    const resolved = await resolvePlaylist(serverId, playlistId);
                    if (!resolved) return;
                    const { songs } = resolved;
                    const prevCount = songs.length;
                    const updatedIds = songs.filter((_, i) => i !== playlistSongIndex).map(s => s.id);
                    await updatePlaylist(playlistId, updatedIds, prevCount);
                    touchPlaylist(playlistId);
                    showToast(t('playlists.removeSuccess'), 3000, 'info');
                  } catch {
                    showToast(t('playlists.removeError'), 4000, 'error');
                  }
                })}>
                  <Trash2 size={14} /> {t('contextMenu.removeFromPlaylist')}
                </div>
              )}
            </>
          );
        })()}

        {type === 'favorite-song' && (() => {
          const song = item as Track;
          return (
            <>
              <div className="context-menu-item" onClick={() => handleAction(() => playTrack(song, [song]))}>
                <Play size={14} /> {t('contextMenu.playNow')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => playNext([song]))}>
                <ChevronsRight size={14} /> {t('contextMenu.playNext')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => enqueue([song]))}>
                <ListPlus size={14} /> {t('contextMenu.addToQueue')}
              </div>
              {orbitRole === 'guest' && (() => {
                const muted = evaluateOrbitSuggestGate().reason === 'muted';
                return (
                  <div
                    className={`context-menu-item${muted ? ' is-disabled' : ''}`}
                    {...(muted ? { 'data-tooltip': t('orbit.suggestBlockedMuted') } : {})}
                    onClick={() => handleAction(() => {
                      if (muted) { showToast(t('orbit.suggestBlockedMuted'), 3500, 'error'); return; }
                      suggestOrbitTrack(song.id)
                        .then(() => showToast(t('orbit.ctxSuggestedToast'), 2200, 'info'))
                        .catch(err => {
                          if (err instanceof OrbitSuggestBlockedError && err.reason === 'muted') {
                            showToast(t('orbit.suggestBlockedMuted'), 3500, 'error');
                          } else {
                            showToast(t('orbit.ctxSuggestFailed'), 3000, 'error');
                          }
                        });
                    })}
                  >
                    <OrbitIcon size={14} /> {t('orbit.ctxAddToSession')}
                  </div>
                );
              })()}
              {orbitRole === 'host' && (
                <div className="context-menu-item" onClick={() => handleAction(() => {
                  hostEnqueueToOrbit(song.id)
                    .then(() => showToast(t('orbit.ctxAddedHostToast'), 2200, 'info'))
                    .catch(() => showToast(t('orbit.ctxAddHostFailed'), 3000, 'error'));
                })}>
                  <OrbitIcon size={14} /> {t('orbit.ctxAddToSessionHost')}
                </div>
              )}
              {offlinePolicy.canAddToPlaylist && (
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
              )}
              <div className="context-menu-divider" />
              {song.albumId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigateToAlbum(song.albumId!))}>
                  <Disc3 size={14} /> {t('contextMenu.openAlbum')}
                </div>
              )}
              {song.artistId && (
                <div className="context-menu-item" onClick={() => handleAction(() => navigateToArtist(song.artistId!))}>
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
              {offlinePolicy.canRate && (
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
              )}
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => handleAction(() => copyShareLink('track', song.id))}>
                <Share2 size={14} /> {t('contextMenu.shareLink')}
              </div>
              <div className="context-menu-item" onClick={() => handleAction(() => openSongInfo(song.id))}>
                <Info size={14} /> {t('contextMenu.songInfo')}
              </div>
              {offlinePolicy.canFavorite && (
                <>
                  <div className="context-menu-divider" />
                  <div className="context-menu-item" style={{ color: 'var(--danger)' }} onClick={() => handleAction(() => {
                    queueSongStar(song.id, false, song.serverId);
                  })}>
                    <HeartCrack size={14} /> {t('contextMenu.unfavorite')}
                  </div>
                </>
              )}
            </>
          );
        })()}

    </>
  );
}
